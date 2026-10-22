import { useMemo } from 'react';
import { MAX_FRET, TUNINGS, type Instrument, type StringSelection } from '../../../shared/chords';

/** Ported from MaxDac/ChordBuilder (Fretboard and ChordPreview). */

const MARKER_FRETS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
const RED_LINE_FRET = 12;
const BASS_FIRST_FRET = 9;

export function fretRangeFor(instrument: Instrument): number[] {
  const first = instrument === 'bass' ? BASS_FIRST_FRET : 1;
  return Array.from({ length: MAX_FRET - first + 1 }, (_, i) => first + i);
}

export function Fretboard(props: {
  instrument: Instrument;
  strings: StringSelection[];
  onChange(strings: StringSelection[]): void;
}) {
  const { instrument, strings, onChange } = props;
  const frets = useMemo(() => fretRangeFor(instrument), [instrument]);
  const columns = `48px 40px 40px repeat(${frets.length}, 40px) 60px`;
  const update = (index: number, selection: StringSelection) =>
    onChange(strings.map((value, i) => (i === index ? selection : value)));
  const redLine = (fret: number) => instrument === 'bass' && fret === RED_LINE_FRET;

  return (
    <div
      className="fretboard-scroll"
      tabIndex={0}
      aria-label={`Fretboard, ${frets.length} frets, scroll horizontally`}
      data-testid="fretboard"
    >
      <div className="fretboard">
        <div className="fret-header" aria-hidden="true" style={{ gridTemplateColumns: columns }}>
          <span>String</span>
          <span>Mute</span>
          <span>Open</span>
          {frets.map((fret) => (
            <span
              key={fret}
              className={[MARKER_FRETS.has(fret) ? 'marker' : '', redLine(fret) ? 'red-line-fret' : '']
                .filter(Boolean)
                .join(' ')}
            >
              {fret}
            </span>
          ))}
          <span>Finger</span>
        </div>
        {TUNINGS[instrument]
          .map((tuning, index) => ({ tuning, index }))
          .map(({ tuning, index }) => {
            const selection = strings[index] ?? { state: 'muted' };
            return (
              <fieldset
                className="string-row"
                style={{ gridTemplateColumns: columns }}
                key={`${instrument}-${index}`}
              >
                <legend className="sr-only">String {tuning}</legend>
                <strong className="tuning-label">{tuning}</strong>
                <button
                  type="button"
                  className={selection.state === 'muted' ? 'selected muted' : ''}
                  aria-pressed={selection.state === 'muted'}
                  aria-label={`Mute ${tuning}`}
                  onClick={() => update(index, { state: 'muted' })}
                >
                  ×
                </button>
                <button
                  type="button"
                  className={selection.state === 'open' ? 'selected open' : ''}
                  aria-pressed={selection.state === 'open'}
                  aria-label={`Open ${tuning}`}
                  onClick={() => update(index, { state: 'open' })}
                >
                  O
                </button>
                {frets.map((fret) => {
                  const selected = selection.state === 'fretted' && selection.fret === fret;
                  return (
                    <button
                      type="button"
                      key={fret}
                      className={[
                        'fret',
                        selected ? 'selected fretted' : '',
                        MARKER_FRETS.has(fret) ? 'marker-fret' : '',
                        redLine(fret) ? 'red-line-fret' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-pressed={selected}
                      aria-label={`${tuning} fret ${fret}`}
                      onClick={() =>
                        update(index, {
                          state: 'fretted',
                          fret,
                          finger: selection.state === 'fretted' ? selection.finger : 1,
                        })
                      }
                    >
                      {selected ? selection.finger : ''}
                    </button>
                  );
                })}
                <select
                  aria-label={`Finger for ${tuning}`}
                  disabled={selection.state !== 'fretted'}
                  value={selection.state === 'fretted' ? selection.finger : 1}
                  onChange={(e) => {
                    if (selection.state === 'fretted')
                      update(index, { ...selection, finger: Number(e.target.value) });
                  }}
                >
                  {[1, 2, 3, 4].map((finger) => (
                    <option value={finger} key={finger}>
                      {finger}
                    </option>
                  ))}
                </select>
              </fieldset>
            );
          })}
      </div>
    </div>
  );
}

const PREVIEW_WINDOW = 4;

function previewStart(strings: readonly StringSelection[]): number {
  const frets = strings.flatMap((s) => (s.state === 'fretted' ? [s.fret] : []));
  if (frets.length === 0) return 1;
  const min = Math.min(...frets);
  const max = Math.max(...frets);
  if (max - min < PREVIEW_WINDOW) return Math.max(1, min);
  return Math.max(1, max - PREVIEW_WINDOW + 1);
}

/** Small diagram of a chord shape, lowest string on top as in the fretboard. */
export function ChordPreview(props: {
  instrument: Instrument;
  strings: readonly StringSelection[];
  label: string;
}) {
  const start = previewStart(props.strings);
  const columns = Array.from({ length: PREVIEW_WINDOW }, (_, i) => start + i);
  const rows = TUNINGS[props.instrument].map((tuning, index) => ({ tuning, index }));
  return (
    <div className="chord-preview" role="img" aria-label={props.label}>
      {start > 1 && <span className="chord-preview-position">{start}fr</span>}
      <div className="chord-preview-grid">
        {rows.map(({ tuning, index }) => {
          const s = props.strings[index];
          return (
            <div className="chord-preview-row" key={`${tuning}-${index}`}>
              <span className="chord-preview-indicator" aria-hidden="true">
                {!s || s.state === 'muted' ? '×' : s.state === 'open' ? 'O' : ''}
              </span>
              <div className="chord-preview-frets">
                {columns.map((fret) => (
                  <span className="chord-preview-cell" key={fret}>
                    {s?.state === 'fretted' && s.fret === fret && (
                      <span className="chord-preview-dot">{s.finger}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
