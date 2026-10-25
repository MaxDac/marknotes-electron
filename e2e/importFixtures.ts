import { crc32, deflateRawSync } from 'node:zlib';

/** A 1×1 PNG. */
export const importPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A ZIP archive with deflated entries. */
export function zip(files: Record<string, string | Uint8Array>): Buffer {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value);
    const compressed = deflateRawSync(data);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    chunks.push(local, fileName, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    local.copy(entry, 10, 8, 26);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** A Word document with the styles, numbering and relationships of Android's DocxToMarkdownTest. */
export function docx(
  body: string,
  image: Uint8Array = new Uint8Array([1, 2, 3]),
  extra: Record<string, string> = {},
) {
  return zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}"><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}">
      <w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      <w:style w:styleId="Titre2"><w:name w:val="heading 2"/></w:style>
      <w:style w:styleId="MyHeading"><w:name w:val="My heading"/><w:basedOn w:val="Heading1"/></w:style>
      <w:style w:styleId="Quote"><w:name w:val="Quote"/></w:style>
      <w:style w:styleId="Code"><w:name w:val="Code"/></w:style>
      </w:styles>`,
    'word/numbering.xml': `<w:numbering xmlns:w="${W}">
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
        <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      </w:numbering>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Target="https://example.com" TargetMode="External"/>
      <Relationship Id="rId2" Target="media/image1.png"/>
      </Relationships>`,
    'word/media/image1.png': image,
    ...extra,
  });
}

/** A paragraph, optionally styled or numbered (`num` is the numbering id and level). */
export function p(text: string, style?: string, num?: [number, number]): string {
  const props =
    (style ? `<w:pStyle w:val="${style}"/>` : '') +
    (num ? `<w:numPr><w:ilvl w:val="${num[1]}"/><w:numId w:val="${num[0]}"/></w:numPr>` : '');
  return `<w:p><w:pPr>${props}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** A paragraph with the image of relationship rId2. */
export const docxImage =
  '<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId2"/>' +
  '</a:graphicData></a:graphic></w:drawing></w:r></w:p>';

/** A one-page PDF, with a line of text or (like a scan) without any. */
export function importPdf(withText = true): Buffer {
  const stream = withText ? 'BT /F1 12 Tf 30 100 Td (PDF imported text.) Tj ET' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
