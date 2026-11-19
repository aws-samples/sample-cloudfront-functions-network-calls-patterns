// A small JavaScript highlighter for the function code panel. No DOM, so the tests
// run it over every pattern's function files: the tokens joined back together must
// give the file byte for byte, so what the page shows is what CloudFront runs.
//
// highlight(source) -> lines, each a list of [kind, text]; kind is '' for plain text,
// or com (comment), str (string or template), re (regex literal), num, kw (keyword),
// lit (true, false, null, undefined), fn (a name called or declared).

const KEYWORDS = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield', 'from']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
// After one of these (or at the start), a / opens a regex literal, not a division.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;

export function tokenize(src) {
  const out = [];
  let i = 0;
  let before = ''; // the code so far on this statement, for the regex rule
  const push = (kind, text) => {
    out.push([kind, text]);
    before = kind === 'com' ? before : (before + text).slice(-40);
  };
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    let m;
    if ((m = /^\/\/[^\n]*/.exec(rest)) || (m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) push('com', m[0]);
    else if (c === '"' || c === "'") {
      m = (c === '"' ? /^"(?:[^"\\\n]|\\[\s\S])*"?/ : /^'(?:[^'\\\n]|\\[\s\S])*'?/).exec(rest);
      push('str', m[0]);
    } else if (c === '`') {
      // A template, ${…} included: braces are counted so a nested } does not end it.
      let j = 1;
      let depth = 0;
      while (j < rest.length) {
        if (rest[j] === '\\') { j += 2; continue; }
        if (depth === 0 && rest[j] === '`') { j++; break; }
        if (rest[j] === '$' && rest[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && rest[j] === '{') depth++;
        else if (depth > 0 && rest[j] === '}') depth--;
        j++;
      }
      m = [rest.slice(0, j)];
      push('str', m[0]);
    } else if (c === '/' && REGEX_AFTER.test(before) && (m = /^\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*/.exec(rest))) push('re', m[0]);
    else if ((m = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?|\.\d+)/.exec(rest)) && !/[\w$]$/.test(before)) push('num', m[0]);
    else if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
      const word = m[0];
      const prop = /\.\s*$/.test(before) && !/\.\.\.\s*$/.test(before);
      const kind = !prop && KEYWORDS.has(word) ? 'kw' : !prop && LITERALS.has(word) ? 'lit' : /^\s*\(/.test(src.slice(i + word.length)) || /\bfunction\s+$/.test(before) ? 'fn' : '';
      push(kind, word);
    } else {
      m = /^(?:\s+|[^\sA-Za-z_$\d'"`/]+|.)/.exec(rest);
      push('', m[0]);
    }
    i += m[0].length;
  }
  return out;
}

// Tokens split at line ends: one list per line, a token that spans lines (a block
// comment, a template) is cut into one piece per line.
export function highlight(src) {
  const lines = [[]];
  for (const [kind, text] of tokenize(src)) {
    text.split('\n').forEach((piece, k) => {
      if (k) lines.push([]);
      if (piece) lines.at(-1).push([kind, piece]);
    });
  }
  return lines;
}
