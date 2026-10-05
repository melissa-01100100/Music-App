/**
 * Getting files off the phone: Web Share API with files (Android share sheet), falling back
 * to normal downloads. Android Chrome only shares an allow-list of file types: .wav is on it,
 * .json is not, so the JSON is offered as a .json.txt (text/plain) copy if needed.
 */

export type ExportResult = 'shared' | 'shared-wav-downloaded-json' | 'cancelled' | 'downloaded';

/** First candidate file set the browser says it can share, or null. Pure (testable). */
export function pickShareSet<T>(candidates: readonly T[][], canShare: (files: T[]) => boolean): T[] | null {
  for (const c of candidates) {
    try {
      if (canShare(c)) return c;
    } catch {
      // canShare can throw on unsupported types in some browsers: try the next set.
    }
  }
  return null;
}

export async function shareOrDownload(wav: File, json: File, title: string): Promise<ExportResult> {
  const jsonAsText = new File([json], `${json.name}.txt`, { type: 'text/plain' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    const set = pickShareSet([[wav, json], [wav, jsonAsText], [wav]], (files) => nav.canShare!({ files }));
    if (set) {
      try {
        await nav.share({ files: set, title });
        if (set.length === 1) {
          download(json);
          return 'shared-wav-downloaded-json';
        }
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
        console.warn('[export] share failed, downloading instead', err);
      }
    }
  }
  download(wav);
  // Some browsers drop a second download started in the same tick.
  await new Promise((r) => setTimeout(r, 400));
  download(json);
  return 'downloaded';
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
