// Matching by artist and title, with case, accents and punctuation folded.
// Nothing fuzzier than that: a track that does not match is reported, never guessed.
export function fold(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[‘’`´]/g, "'")
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function trackKey(artist, title) {
  const a = fold(artist);
  const t = fold(title);
  if (!a || !t) return null;
  return `${a}\u0000${t}`;
}
