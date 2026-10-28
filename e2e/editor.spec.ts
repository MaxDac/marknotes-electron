import { expect, test } from './fixtures';
import { createNote, editorText } from './helpers';

test('editor shortcuts continue and indent lists and undo edits', async ({ launch }) => {
  const { page } = await launch();
  await createNote(page, 'Shortcuts');
  const field = page.getByTestId('editor-field');
  await field.click();

  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toBe('- one\n- ');
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await expect.poll(() => editorText(page)).toBe('- one\n  - two');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => editorText(page)).toBe('- one\n- two');
  // Enter on an empty item ends the list.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toBe('- one\n- two\n');

  await page.keyboard.type('1. first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await expect.poll(() => editorText(page)).toBe('- one\n- two\n1. first\n2. second');

  await page.waitForTimeout(800);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editorText(page)).not.toContain('second');
  // CodeMirror's redo: Cmd+Shift+Z on macOS, Ctrl+Y elsewhere.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
  await expect.poll(() => editorText(page)).toBe('- one\n- two\n1. first\n2. second');

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect.poll(() => editorText(page)).toBe('');
});

test('the @ popup is driven by the keyboard and Escape keeps the typed text', async ({ launch }) => {
  const { page } = await launch();
  await createNote(page, 'Alpha topic', 'a');
  await createNote(page, 'Beta topic', 'b');
  await createNote(page, 'Source');
  await page.getByTestId('editor-field').click();
  await page.keyboard.type('@topic');
  const popup = page.getByTestId('mention-popup');
  const options = popup.getByTestId('mention-option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  const title = (await options.nth(1).locator('.mention-title').textContent())!;

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect.poll(() => editorText(page)).toBe('@topic');

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('@topic');
  await expect(options).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(popup).toBeHidden();
  await expect
    .poll(() => editorText(page))
    .toMatch(new RegExp(`^\\[${title}\\]\\(marknotes:[0-9a-hjkmnp-tv-z]{8}\\)`));
});

test('a link to a missing note is marked as broken and reports it when opened', async ({ launch }) => {
  const { page } = await launch();
  await createNote(page, 'Target', 'here');
  await createNote(page, 'Source');
  await page.getByTestId('editor-field').click();
  await page.keyboard.type('@Targ');
  await expect(page.getByTestId('mention-option').filter({ hasText: 'Target' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toMatch(/marknotes:[0-9a-hjkmnp-tv-z]{8}\)$/);
  const id = /marknotes:([0-9a-hjkmnp-tv-z]{8})/.exec(await editorText(page))![1];
  const missing = id === 'zzzzzzzz' ? 'yyyyyyyy' : 'zzzzzzzz';
  await page.keyboard.type(` and [Gone](marknotes:${missing})`);

  const preview = page.getByTestId('markdown-preview');
  const working = preview.getByRole('link', { name: 'Target' });
  const broken = preview.getByRole('link', { name: 'Gone' });
  await expect(working).not.toHaveClass(/broken/);
  await expect(broken).toHaveClass(/broken/);
  await expect(broken).toHaveAttribute('title', 'Note not found');

  await broken.click();
  await expect(page.getByRole('alert')).toContainText('Note not found');
  await expect(page.getByTestId('note-title')).toHaveText('Source');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await working.click();
  await expect(page.getByTestId('note-title')).toHaveText('Target');
});

test('vim mode is off by default and, once enabled, edits with Vim gestures', async ({ launch }) => {
  const { page } = await launch();
  await page.getByRole('button', { name: 'Settings' }).click();
  const toggle = page.getByRole('switch', { name: 'Vim mode' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: 'Back' }).click();

  await createNote(page, 'Vim');
  await page.getByTestId('editor-field').click();
  // Normal mode first: "i" enters insert mode instead of typing a letter.
  await page.keyboard.press('Escape');
  await page.keyboard.type('ihello world');
  await page.keyboard.press('Escape');
  await expect.poll(() => editorText(page)).toBe('hello world');
  await page.keyboard.type('0x');
  await expect.poll(() => editorText(page)).toBe('ello world');
  await page.keyboard.type('yyp');
  await expect.poll(() => editorText(page)).toBe('ello world\nello world');
  await page.keyboard.type('dd');
  await expect.poll(() => editorText(page)).toBe('ello world');
  await page.keyboard.type('u');
  await expect.poll(() => editorText(page)).toBe('ello world\nello world');
  // Enter in normal mode is a motion and does not continue a list or add a line.
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toBe('ello world\nello world');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Vim mode' }).uncheck();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('editor-field').click();
  await page.keyboard.type('i');
  await expect.poll(() => editorText(page)).toContain('i');
});
