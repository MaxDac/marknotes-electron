/**
 * Converts Word documents (`.docx`, Office Open XML) to Markdown: headings, bold/italic/strikethrough, links,
 * bulleted and numbered lists, quotes, code paragraphs, tables and embedded images (handed to an `ImageSink`).
 * Mirrors Android's `core/importing/DocxToMarkdown.kt`. XML is parsed with the inert `DOMParser`; documents with
 * a DOCTYPE are rejected (no entity expansion).
 */
import { imageMarkdown } from '../attachments';
import { ImportError, NO_IMAGES, type ImageSink } from './importError';
import {
  BlockBuilder,
  escapeInline,
  escapeLineStart,
  fence,
  HARD_BREAK,
  link,
  table as markdownTable,
  tidy,
  wrap,
} from './markdownText';
import { readZip, ZipTooLargeError } from './zip';

const DOCUMENT = 'word/document.xml';
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const NOT_A_DOCUMENT = "This file isn't a valid Word document.";
export const TOO_LARGE = 'This document is too large to import.';
export const DAMAGED = "This Word document is damaged and can't be read.";

const LIST_INDENT = '    ';
const MAX_LEVEL = 8;
const MAX_HEADING = 6;

export async function docxToMarkdown(bytes: Uint8Array, images: ImageSink = NO_IMAGES): Promise<string> {
  const reader = new DocxReader(await unzip(bytes), false);
  const text = reader.render();
  return tidy(await reader.resolveImages(text, images));
}

/** The text of the document, one paragraph per line, table cells separated by tabs. */
export async function docxToPlainText(bytes: Uint8Array): Promise<string> {
  return tidy(new DocxReader(await unzip(bytes), true).render());
}

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes, (name) => name.startsWith('word/'), {
      entry: MAX_ENTRY_BYTES,
      total: MAX_TOTAL_BYTES,
    });
  } catch (e) {
    throw new ImportError(e instanceof ZipTooLargeError ? TOO_LARGE : NOT_A_DOCUMENT, { cause: e });
  }
  if (!entries.has(DOCUMENT)) throw new ImportError(NOT_A_DOCUMENT);
  return entries;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  raw: boolean;
}

/** Whether `b` can be merged into `a`: both formatted text with the same emphasis. */
const mergesWith = (a: Run, b: Run) =>
  !a.raw && !b.raw && a.bold === b.bold && a.italic === b.italic && a.strike === b.strike;

const rawRun = (text: string): Run => ({ text, bold: false, italic: false, strike: false, raw: true });

interface PendingImage {
  token: string;
  bytes: Uint8Array;
  extension: string;
  fileName: string;
}

class DocxReader {
  private readonly styles: StyleSheet;
  private readonly numbering: Numbering;
  private readonly relationships: Map<string, Relationship>;
  private readonly counters = new Map<string, number[]>();
  private readonly out = new BlockBuilder();
  private readonly code: string[] = [];
  private readonly pending: PendingImage[] = [];

  constructor(
    private readonly entries: Map<string, Uint8Array>,
    private readonly plain: boolean,
  ) {
    this.styles = new StyleSheet(this.xml('word/styles.xml'));
    this.numbering = new Numbering(this.xml('word/numbering.xml'));
    this.relationships = relationships(this.xml('word/_rels/document.xml.rels'));
  }

  private xml(name: string): Document | null {
    const bytes = this.entries.get(name);
    return bytes ? parseXml(bytes) : null;
  }

  render(): string {
    const document = this.xml(DOCUMENT)!;
    const body = child(document.documentElement, 'body');
    if (!body) return '';
    this.blocks(body);
    this.flushCode();
    return this.out.toString();
  }

  /** Stores the images found while rendering and replaces their placeholders with image Markdown. */
  async resolveImages(text: string, sink: ImageSink): Promise<string> {
    let result = text;
    for (const image of this.pending) {
      let saved: string | null;
      try {
        saved = await sink(image.bytes, image.extension, image.fileName);
      } catch {
        saved = null;
      }
      result = result.replace(image.token, saved ? imageMarkdown(image.fileName, saved) : '');
    }
    return result;
  }

  private blocks(parent: Element): void {
    for (const el of childElements(parent)) {
      switch (el.localName) {
        case 'p':
          this.paragraph(el);
          break;
        case 'tbl':
          this.table(el);
          break;
        case 'sdt': {
          const content = child(el, 'sdtContent');
          if (content) this.blocks(content);
          break;
        }
        case 'customXml':
        case 'ins':
          this.blocks(el);
          break;
      }
    }
  }

  private paragraph(p: Element): void {
    const properties = child(p, 'pPr');
    const styleId = attrOf(child(properties, 'pStyle'), 'val');
    const numPr = child(properties, 'numPr');
    const rawNumId = attrOf(child(numPr, 'numId'), 'val');
    const numId = rawNumId !== null && rawNumId !== '0' ? rawNumId : null;
    const level = toInt(attrOf(child(numPr, 'ilvl'), 'val')) ?? 0;
    if (!this.plain && this.styles.isCode(styleId)) {
      this.code.push(this.runs(p, false, true));
      return;
    }
    this.flushCode();
    const outline = toInt(attrOf(child(properties, 'outlineLvl'), 'val'));
    const heading =
      this.styles.headingLevel(styleId) ?? (outline !== null && outline < MAX_HEADING ? outline + 1 : null);
    const text = trimBreaks(this.runs(p, heading === null, false));
    if (text === '') return;
    if (this.plain) this.out.block(text);
    else if (heading !== null) this.out.block(`${'#'.repeat(heading)} ${singleLine(text)}`);
    else if (numId !== null) {
      this.out.item(LIST_INDENT.repeat(clamp(level, 0, MAX_LEVEL)) + this.marker(numId, level) + text);
    } else if (this.styles.isQuote(styleId)) {
      this.out.block(
        text
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      );
    } else this.out.block(text.split('\n').map(escapeLineStart).join('\n'));
  }

  private marker(numId: string, level: number): string {
    const format = this.numbering.format(numId, level);
    if (format === null || format === 'bullet' || format === 'none') return '- ';
    let levels = this.counters.get(numId);
    if (!levels) {
      levels = new Array<number>(MAX_LEVEL + 1).fill(0);
      this.counters.set(numId, levels);
    }
    const index = clamp(level, 0, MAX_LEVEL);
    levels[index]++;
    for (let deeper = index + 1; deeper <= MAX_LEVEL; deeper++) levels[deeper] = 0;
    return `${this.numbering.start(numId, level) + levels[index] - 1}. `;
  }

  private flushCode(): void {
    if (this.code.length === 0) return;
    this.out.block(fence(this.code.join('\n')));
    this.code.length = 0;
  }

  private table(tbl: Element): void {
    const rows = childElements(tbl)
      .filter((el) => el.localName === 'tr')
      .map((row) => childElements(row).filter((el) => el.localName === 'tc'))
      .filter((row) => row.length > 0);
    if (rows.length === 0) return;
    if (Math.max(...rows.map((r) => r.length)) <= 1) {
      rows.flat().forEach((cell) => this.blocks(cell));
      return;
    }
    this.flushCode();
    const cells = rows.map((row) =>
      row.map((cell) =>
        singleLine(
          descendants(cell, 'p')
            .map((p) => this.runs(p, true, false).trim())
            .join(' '),
        ),
      ),
    );
    this.out.block(this.plain ? cells.map((r) => r.join('\t')).join('\n') : markdownTable(cells));
  }

  /** The inline content of a paragraph (or hyperlink) as Markdown, or as text when `raw`. */
  private runs(parent: Element, emphasis: boolean, raw: boolean): string {
    const collected: Run[] = [];
    this.collect(parent, collected, raw);
    return this.format(collected, emphasis && !this.plain && !raw, raw);
  }

  private collect(parent: Element, into: Run[], raw: boolean): void {
    for (const el of childElements(parent)) {
      switch (el.localName) {
        case 'r':
          this.run(el, into, raw);
          break;
        case 'hyperlink':
          this.hyperlink(el, into, raw);
          break;
        case 'ins':
        case 'smartTag':
        case 'fldSimple':
        case 'customXml':
        case 'sdtContent':
          this.collect(el, into, raw);
          break;
        case 'sdt': {
          const content = child(el, 'sdtContent');
          if (content) this.collect(content, into, raw);
          break;
        }
      }
    }
  }

  private hyperlink(el: Element, into: Run[], raw: boolean): void {
    const id = attrOf(el, 'id');
    const rel = id !== null ? this.relationships.get(id) : undefined;
    const target = rel?.external ? rel.target : null;
    if (target === null || this.plain || raw) {
      this.collect(el, into, raw);
      return;
    }
    const label = this.runs(el, true, false).trim();
    if (label !== '') into.push(rawRun(link(singleLine(label), target)));
  }

  private run(r: Element, into: Run[], raw: boolean): void {
    const props = child(r, 'rPr');
    if (flag(props, 'vanish')) return;
    const style = {
      bold: flag(props, 'b'),
      italic: flag(props, 'i'),
      strike: flag(props, 'strike') || flag(props, 'dstrike'),
    };
    for (const el of childElements(r)) {
      const part = this.runPart(el, style, raw);
      if (part) into.push(part);
    }
  }

  private runPart(el: Element, style: Omit<Run, 'text' | 'raw'>, raw: boolean): Run | null {
    const text = (value: string): Run => ({ ...style, text: value, raw: false });
    switch (el.localName) {
      case 't':
        return text(el.textContent ?? '');
      case 'tab':
        return text(raw ? '\t' : ' ');
      case 'noBreakHyphen':
        return text('-');
      case 'br':
      case 'cr': {
        const type = attrOf(el, 'type');
        if (type !== null && type !== 'textWrapping') return null;
        return rawRun(raw || this.plain ? '\n' : HARD_BREAK);
      }
      case 'drawing':
      case 'pict':
      case 'object':
        return !this.plain && !raw ? this.image(el) : null;
      default:
        return null;
    }
  }

  private image(el: Element): Run | null {
    const id =
      descendants(el, 'blip')
        .map((b) => attrOf(b, 'embed'))
        .find((v) => v !== null) ??
      descendants(el, 'imagedata')
        .map((d) => attrOf(d, 'id'))
        .find((v) => v !== null);
    if (id === undefined || id === null) return null;
    const rel = this.relationships.get(id);
    if (!rel || rel.external) return null;
    const path = resolve(rel.target);
    const bytes = this.entries.get(path);
    if (!bytes) return null;
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    const dot = fileName.lastIndexOf('.');
    const ext = dot < 0 ? '' : fileName.substring(dot + 1).toLowerCase();
    let extension: string;
    if (ext === 'jpeg' || ext === 'jpg') extension = 'jpg';
    else if (ext === 'png' || ext === 'gif' || ext === 'webp') extension = ext;
    else return null;
    const token = `\uE000${this.pending.length}\uE001`;
    this.pending.push({ token, bytes, extension, fileName });
    return rawRun(token);
  }

  private format(runs: Run[], emphasis: boolean, raw: boolean): string {
    const merged: Run[] = [];
    for (const run of runs) {
      const last = merged.at(-1);
      if (last && mergesWith(last, run)) merged[merged.length - 1] = { ...run, text: last.text + run.text };
      else merged.push(run);
    }
    return merged.map((run) => (run.raw || raw || this.plain ? run.text : emphasize(run, emphasis))).join('');
  }
}

function emphasize(run: Run, emphasis: boolean): string {
  let text = escapeInline(run.text);
  if (!emphasis) return text;
  if (run.strike) text = wrap(text, '~~');
  if (run.italic) text = wrap(text, '*');
  if (run.bold) text = wrap(text, '**');
  return text;
}

/** Trims whitespace and line breaks at both ends (a trailing hard break would show as a backslash). */
function trimBreaks(text: string): string {
  let result = text.trim();
  for (;;) {
    if (result.endsWith('\\') && !result.endsWith('\\\\')) result = result.slice(0, -1).trim();
    else if (result.startsWith(HARD_BREAK)) result = result.substring(HARD_BREAK.length).trim();
    else return result;
  }
}

const singleLine = (text: string) => text.replaceAll(HARD_BREAK, ' ').replaceAll('\n', ' ').trim();
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function toInt(value: string | null): number | null {
  if (value === null || !/^[+-]?\d{1,9}$/.test(value)) return null;
  return parseInt(value, 10);
}

function resolve(target: string): string {
  if (target.startsWith('/')) return target.substring(1);
  const parts = ['word'];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function flag(props: Element | null, name: string): boolean {
  const el = child(props, name);
  if (!el) return false;
  const value = attrOf(el, 'val')?.toLowerCase();
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value);
}

interface Relationship {
  target: string;
  external: boolean;
}

function relationships(doc: Document | null): Map<string, Relationship> {
  const result = new Map<string, Relationship>();
  if (!doc) return result;
  for (const rel of childElements(doc.documentElement)) {
    if (rel.localName !== 'Relationship') continue;
    const id = attrOf(rel, 'Id');
    const target = attrOf(rel, 'Target');
    if (id === null || target === null) continue;
    result.set(id, { target, external: attrOf(rel, 'TargetMode') === 'External' });
  }
  return result;
}

/** Paragraph styles of the document (`word/styles.xml`), resolved through their `basedOn` chain. */
class StyleSheet {
  private static readonly MAX_DEPTH = 8;
  private static readonly HEADING = /heading\s*(\d)/i;
  private static readonly CODE = /code|preformatted|source/;
  private readonly styles = new Map<string, { name: string; basedOn: string | null }>();

  constructor(doc: Document | null) {
    if (!doc) return;
    for (const el of childElements(doc.documentElement)) {
      if (el.localName !== 'style') continue;
      const id = attrOf(el, 'styleId');
      if (id === null) continue;
      this.styles.set(id, {
        name: (attrOf(child(el, 'name'), 'val') ?? '').toLowerCase(),
        basedOn: attrOf(child(el, 'basedOn'), 'val'),
      });
    }
  }

  headingLevel(styleId: string | null): number | null {
    return this.resolve(styleId, (id, name) => {
      if (name === 'title' || id.toLowerCase() === 'title') return 1;
      if (name === 'subtitle' || id.toLowerCase() === 'subtitle') return 2;
      const m = StyleSheet.HEADING.exec(name) ?? StyleSheet.HEADING.exec(id);
      return m ? clamp(parseInt(m[1], 10), 1, 6) : null;
    });
  }

  isQuote(styleId: string | null): boolean {
    return (
      this.resolve(styleId, (id, name) =>
        name.includes('quote') || id.toLowerCase().includes('quote') ? true : null,
      ) === true
    );
  }

  isCode(styleId: string | null): boolean {
    return (
      this.resolve(styleId, (id, name) =>
        StyleSheet.CODE.test(name) || StyleSheet.CODE.test(id.toLowerCase()) ? true : null,
      ) === true
    );
  }

  private resolve<T>(styleId: string | null, check: (id: string, name: string) => T | null): T | null {
    let id = styleId;
    for (let i = 0; i < StyleSheet.MAX_DEPTH; i++) {
      if (id === null) return null;
      const style = this.styles.get(id);
      const found = check(id, style?.name ?? '');
      if (found !== null) return found;
      id = style?.basedOn ?? null;
    }
    return null;
  }
}

/** List definitions of the document (`word/numbering.xml`). */
class Numbering {
  private readonly levels = new Map<string, Map<number, { format: string | null; start: number }>>();
  private readonly abstractOf = new Map<string, string>();

  constructor(doc: Document | null) {
    if (!doc) return;
    for (const el of childElements(doc.documentElement)) {
      if (el.localName === 'abstractNum') {
        const id = attrOf(el, 'abstractNumId');
        if (id === null) continue;
        const levels = new Map<number, { format: string | null; start: number }>();
        for (const lvl of childElements(el)) {
          if (lvl.localName !== 'lvl') continue;
          const level = toInt(attrOf(lvl, 'ilvl'));
          if (level === null) continue;
          levels.set(level, {
            format: attrOf(child(lvl, 'numFmt'), 'val'),
            start: toInt(attrOf(child(lvl, 'start'), 'val')) ?? 1,
          });
        }
        this.levels.set(id, levels);
      } else if (el.localName === 'num') {
        const id = attrOf(el, 'numId');
        const abstract = attrOf(child(el, 'abstractNumId'), 'val');
        if (id !== null && abstract !== null) this.abstractOf.set(id, abstract);
      }
    }
  }

  format(numId: string, level: number): string | null {
    return this.level(numId, level)?.format ?? null;
  }

  start(numId: string, level: number): number {
    return this.level(numId, level)?.start ?? 1;
  }

  private level(numId: string, level: number) {
    const abstract = this.abstractOf.get(numId);
    return abstract === undefined ? undefined : this.levels.get(abstract)?.get(level);
  }
}

function parseXml(bytes: Uint8Array): Document {
  const text = decodeXml(bytes);
  // Refused before parsing, so that no entity is ever expanded; Word never writes a DOCTYPE.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ImportError(DAMAGED);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.doctype !== null || doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
    throw new ImportError(DAMAGED);
  }
  return doc;
}

function decodeXml(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

function childElements(el: Element | null): Element[] {
  return el ? Array.from(el.children) : [];
}

function child(el: Element | null, localName: string): Element | null {
  return childElements(el).find((c) => c.localName === localName) ?? null;
}

function descendants(el: Element, localName: string): Element[] {
  const result: Element[] = [];
  const walk = (parent: Element) => {
    for (const c of childElements(parent)) {
      if (c.localName === localName) result.push(c);
      walk(c);
    }
  };
  walk(el);
  return result;
}

/** Attribute by local name, whatever its namespace prefix (`w:val`, `r:id`, ...). */
function attrOf(el: Element | null, localName: string): string | null {
  if (!el) return null;
  for (const attribute of Array.from(el.attributes)) {
    const name = attribute.localName ?? attribute.name.substring(attribute.name.indexOf(':') + 1);
    if (name === localName) return attribute.value;
  }
  return null;
}
