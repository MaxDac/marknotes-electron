/** Stroke icons shared with the web app (`assets/js/components.ts` in marknotes-web): 24px grid, drawn with `currentColor`. */
const paths = {
  plus: 'M12 5v14M5 12h14',
  folder:
    'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  file: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M9 13h6M9 17h4',
  notes: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3',
  chords: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 9l11-2',
  back: 'M15 6l-6 6 6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  cloud: 'M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 11.5 3.25 3.25 0 0 1 17.5 18z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4',
  block: 'M4 5h16v14H4zM10 10l-2 2 2 2M14 10l2 2-2 2',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbered:
    'M10 6h10M10 12h10M10 18h10M4 4.5 5.5 3.5V8M3.5 11a1.25 1.25 0 0 1 2.5.5L3.5 14.5H6M3.5 16.5H6l-1.5 1.5a1.25 1.25 0 1 1-1 2',
  checklist: 'M4 6.5 5.5 8 8 5M4 13.5 5.5 15 8 12M11 7h9M11 14h9M11 19h9',
  quote: 'M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6',
  check: 'M5 12.5l4.5 4.5L19 7',
  plug: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  alert: 'M12 8v5M12 16h.01M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0',
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path d={paths[name]} />
    </svg>
  );
}
