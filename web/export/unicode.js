// export/unicode.js — the characters beyond ASCII that the exported LaTeX
// knows how to set.
//
// The website shows whatever the browser has a glyph for, and KaTeX takes
// `ℝ`, `≤` or `α` in maths as readily as their commands.  pdfLaTeX with T1
// and utf8 knows the Latin letters and the usual punctuation and stops at
// anything else ("Unicode character … not set up for use with LaTeX"), so
// the preamble declares, for exactly the characters a document uses, what
// they are: `\DeclareUnicodeCharacter{2264}{\ensuremath{\leq}}`, which works
// in text and in maths alike.  A character this table does not know is set as
// a visible placeholder and reported, never dropped silently.

/** Code point -> LaTeX, safe in text and in maths. */
const MATHS = {
  // Greek
  0x03B1: '\\alpha', 0x03B2: '\\beta', 0x03B3: '\\gamma', 0x03B4: '\\delta', 0x03B5: '\\varepsilon',
  0x03F5: '\\epsilon', 0x03B6: '\\zeta', 0x03B7: '\\eta', 0x03B8: '\\theta', 0x03D1: '\\vartheta',
  0x03B9: '\\iota', 0x03BA: '\\kappa', 0x03BB: '\\lambda', 0x03BC: '\\mu', 0x03BD: '\\nu',
  0x03BE: '\\xi', 0x03BF: 'o', 0x03C0: '\\pi', 0x03D6: '\\varpi', 0x03C1: '\\rho', 0x03F1: '\\varrho',
  0x03C3: '\\sigma', 0x03C2: '\\varsigma', 0x03C4: '\\tau', 0x03C5: '\\upsilon', 0x03C6: '\\varphi',
  0x03D5: '\\phi', 0x03C7: '\\chi', 0x03C8: '\\psi', 0x03C9: '\\omega',
  0x0393: '\\Gamma', 0x0394: '\\Delta', 0x0398: '\\Theta', 0x039B: '\\Lambda', 0x039E: '\\Xi',
  0x03A0: '\\Pi', 0x03A3: '\\Sigma', 0x03A5: '\\Upsilon', 0x03A6: '\\Phi', 0x03A8: '\\Psi',
  0x03A9: '\\Omega', 0x2126: '\\Omega',
  0x0391: '\\mathrm{A}', 0x0392: '\\mathrm{B}', 0x0395: '\\mathrm{E}', 0x0396: '\\mathrm{Z}',
  0x0397: '\\mathrm{H}', 0x0399: '\\mathrm{I}', 0x039A: '\\mathrm{K}', 0x039C: '\\mathrm{M}',
  0x039D: '\\mathrm{N}', 0x039F: '\\mathrm{O}', 0x03A1: '\\mathrm{P}', 0x03A4: '\\mathrm{T}',
  0x03A7: '\\mathrm{X}',
  // arrows
  0x2190: '\\leftarrow', 0x2191: '\\uparrow', 0x2192: '\\rightarrow', 0x2193: '\\downarrow',
  0x2194: '\\leftrightarrow', 0x2195: '\\updownarrow', 0x21A6: '\\mapsto', 0x21AA: '\\hookrightarrow',
  0x21A9: '\\hookleftarrow', 0x21A0: '\\twoheadrightarrow', 0x21D0: '\\Leftarrow', 0x21D2: '\\Rightarrow',
  0x21D4: '\\Leftrightarrow', 0x21D1: '\\Uparrow', 0x21D3: '\\Downarrow', 0x27F6: '\\longrightarrow',
  0x27F5: '\\longleftarrow', 0x27F7: '\\longleftrightarrow', 0x27F9: '\\Longrightarrow',
  0x27F8: '\\Longleftarrow', 0x27FA: '\\Longleftrightarrow', 0x27FC: '\\longmapsto',
  0x2197: '\\nearrow', 0x2198: '\\searrow', 0x2196: '\\nwarrow', 0x2199: '\\swarrow',
  0x21C4: '\\rightleftarrows', 0x21C9: '\\rightrightarrows', 0x219D: '\\rightsquigarrow',
  // logic and sets
  0x2200: '\\forall', 0x2203: '\\exists', 0x2204: '\\nexists', 0x2205: '\\emptyset', 0x2208: '\\in',
  0x2209: '\\notin', 0x220B: '\\ni', 0x2282: '\\subset', 0x2283: '\\supset', 0x2286: '\\subseteq',
  0x2287: '\\supseteq', 0x228A: '\\subsetneq', 0x228B: '\\supsetneq', 0x222A: '\\cup', 0x2229: '\\cap',
  0x22C3: '\\bigcup', 0x22C2: '\\bigcap', 0x2227: '\\wedge', 0x2228: '\\vee', 0x00AC: '\\neg',
  0x22A2: '\\vdash', 0x22A8: '\\models', 0x22A5: '\\bot', 0x22A4: '\\top', 0x2216: '\\setminus',
  0x2294: '\\sqcup', 0x2A3F: '\\amalg', 0x2210: '\\coprod', 0x2234: '\\therefore', 0x2235: '\\because',
  // relations
  0x2264: '\\leq', 0x2265: '\\geq', 0x2260: '\\neq', 0x2248: '\\approx', 0x2261: '\\equiv',
  0x2245: '\\cong', 0x2243: '\\simeq', 0x223C: '\\sim', 0x221D: '\\propto', 0x226A: '\\ll',
  0x226B: '\\gg', 0x227A: '\\prec', 0x227B: '\\succ', 0x2AAF: '\\preceq', 0x2AB0: '\\succeq',
  0x22B2: '\\lhd', 0x22B3: '\\rhd', 0x2223: '\\mid', 0x2225: '\\parallel', 0x2254: '\\coloneqq',
  0x2A7D: '\\leqslant', 0x2A7E: '\\geqslant', 0x2272: '\\lesssim', 0x2273: '\\gtrsim',
  // operators
  0x221E: '\\infty', 0x2202: '\\partial', 0x2207: '\\nabla', 0x2211: '\\sum', 0x220F: '\\prod',
  0x222B: '\\int', 0x222E: '\\oint', 0x221A: '\\surd', 0x00B1: '\\pm', 0x2213: '\\mp',
  0x00D7: '\\times', 0x00F7: '\\div', 0x00B7: '\\cdot', 0x22C5: '\\cdot', 0x2219: '\\bullet',
  0x2218: '\\circ', 0x2297: '\\otimes', 0x2295: '\\oplus', 0x2299: '\\odot', 0x2212: '-',
  0x22C6: '\\star', 0x2217: '\\ast', 0x2020: '\\dagger', 0x2021: '\\ddagger',
  0x27E8: '\\langle', 0x27E9: '\\rangle', 0x2329: '\\langle', 0x232A: '\\rangle',
  0x230A: '\\lfloor', 0x230B: '\\rfloor', 0x2308: '\\lceil', 0x2309: '\\rceil',
  0x22EF: '\\cdots', 0x22EE: '\\vdots', 0x22F1: '\\ddots', 0x2032: '\\prime', 0x2033: '\\prime\\prime',
  0x2113: '\\ell', 0x2118: '\\wp', 0x2135: '\\aleph', 0x210F: '\\hbar', 0x00B0: '^{\\circ}',
  0x25A1: '\\square', 0x25A0: '\\blacksquare', 0x25E6: '\\circ', 0x2713: '\\checkmark',
  0x2605: '\\bigstar', 0x2227: '\\wedge',
  // blackboard bold and friends
  0x2115: '\\mathbb{N}', 0x2124: '\\mathbb{Z}', 0x211A: '\\mathbb{Q}', 0x211D: '\\mathbb{R}',
  0x2102: '\\mathbb{C}', 0x2119: '\\mathbb{P}', 0x210D: '\\mathbb{H}',
  0x00B9: '^{1}', 0x00B2: '^{2}', 0x00B3: '^{3}', 0x00B5: '\\mu',
};

// Mathematical alphanumerics: the double-struck capitals (𝔸 … 𝕐) and the
// fraktur capitals and small letters.
for (let k = 0; k < 26; k += 1) {
  const L = String.fromCharCode(65 + k);
  const l = String.fromCharCode(97 + k);
  const ds = 0x1D538 + k;
  if (!MATHS[ds] && !'CHNPQRZ'.includes(L)) MATHS[ds] = `\\mathbb{${L}}`;
  MATHS[0x1D504 + k] = `\\mathfrak{${L}}`;
  MATHS[0x1D51E + k] = `\\mathfrak{${l}}`;
  MATHS[0x1D49C + k] = `\\mathcal{${L}}`;
}
for (let d = 0; d <= 9; d += 1) {
  MATHS[[0x2070, 0x00B9, 0x00B2, 0x00B3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079][d]] = `^{${d}}`;
  MATHS[0x2080 + d] = `_{${d}}`;
}

/** Code point -> LaTeX, for text only (punctuation and spaces). */
const TEXT = {
  0x2009: '\\,', 0x202F: '\\,', 0x200A: '\\,', 0x2002: '\\enspace', 0x2003: '\\quad',
  0x200B: '\\hspace{0pt}', 0x2060: '', 0xFEFF: '', 0x2010: '-', 0x2011: '\\mbox{-}', 0x2012: '--',
  0x2015: '---', 0x2032: '\\ensuremath{\\prime}', 0x2043: '-', 0x2116: 'No.', 0x2122: '\\texttrademark{}',
  0x2026: '\\ldots{}',
};

/** Whether pdfLaTeX's utf8 and T1 already know the character in text. */
function knownToLatex(cp) {
  // Latin-1 and Latin Extended-A, and the punctuation the TS1 encoding has.
  if (cp >= 0xA0 && cp <= 0x17F) return true;
  return [0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2022, 0x2030,
    0x2039, 0x203A, 0x20AC, 0x0218, 0x0219, 0x021A, 0x021B, 0x02C6, 0x02DC].includes(cp);
}

/** Letters that are fine in text but are text commands for LaTeX, so must not
 *  be met in maths bare: `\mathrm{ét}` is `\mathrm{\text{é}t}`. */
export function isTextLetter(cp) {
  return cp >= 0xA0 && cp <= 0x17F && !MATHS[cp];
}

/**
 * The `\DeclareUnicodeCharacter` lines for the characters of `text`, and the
 * characters it could not place (as `U+XXXX` strings).
 */
export function unicodeDeclarations(text) {
  const seen = new Set();
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7F) seen.add(cp);
  }
  const lines = [];
  const unknown = [];
  for (const cp of [...seen].sort((a, b) => a - b)) {
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    if (cp >= 0xE000 && cp <= 0xF8FF) continue; // private use: never in the output
    if (MATHS[cp] !== undefined && !(knownToLatex(cp) && !needsMathsForm(cp))) {
      lines.push(`\\DeclareUnicodeCharacter{${hex}}{\\ensuremath{${MATHS[cp]}}}`);
    } else if (TEXT[cp] !== undefined) {
      lines.push(`\\DeclareUnicodeCharacter{${hex}}{${TEXT[cp]}}`);
    } else if (!knownToLatex(cp)) {
      unknown.push('U+' + hex);
      lines.push(`\\DeclareUnicodeCharacter{${hex}}{\\bpglyph{U+${hex}}}`);
    }
  }
  return { lines, unknown };
}

// Latin-1 characters LaTeX sets in text but that maths needs too: their text
// forms (`\texttimes`, `\textpm`, …) stop a formula.
function needsMathsForm(cp) {
  return [0xAC, 0xB0, 0xB1, 0xB5, 0xB7, 0xD7, 0xF7, 0xB9, 0xB2, 0xB3].includes(cp);
}
