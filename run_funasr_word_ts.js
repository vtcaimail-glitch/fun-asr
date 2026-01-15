#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_ASR =
  'D:\\0_code\\3.Full-pipeline\\fun-asr\\models\\iic\\speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch';
const MODEL_VAD =
  'D:\\0_code\\3.Full-pipeline\\fun-asr\\models\\iic\\speech_fsmn_vad_zh-cn-16k-common-pytorch';
const MODEL_PUNC =
  'D:\\0_code\\3.Full-pipeline\\fun-asr\\models\\iic\\punc_ct-transformer_cn-en-common-vocab471067-large';

function usageAndExit() {
  const scriptName = path.basename(process.argv[1] || 'run_funasr_word_ts.js');
  process.stderr.write(`Usage:\n  node ${scriptName} "D:\\\\path\\\\to\\\\audio.wav"\n`);
  process.exit(2);
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function scriptDir() {
  return __dirname || process.cwd();
}

function venvPythonPath(baseDir) {
  const win = process.platform === 'win32';
  return win
    ? path.join(baseDir, '.venv', 'Scripts', 'python.exe')
    : path.join(baseDir, '.venv', 'bin', 'python');
}

function venvFunasrExePath(baseDir) {
  const win = process.platform === 'win32';
  return win
    ? path.join(baseDir, '.venv', 'Scripts', 'funasr.exe')
    : path.join(baseDir, '.venv', 'bin', 'funasr');
}

function venvHasFunasrModule(baseDir) {
  const win = process.platform === 'win32';
  const sitePackages = win
    ? path.join(baseDir, '.venv', 'Lib', 'site-packages')
    : path.join(baseDir, '.venv', 'lib');

  // Fast file-based check; avoids running Python just to probe imports.
  return (
    exists(path.join(sitePackages, 'funasr')) ||
    // Some installs may not have a top-level package folder visible here due to layout;
    // keeping a secondary check for dist-info is still useful.
    (exists(sitePackages) &&
      fs
        .readdirSync(sitePackages, { withFileTypes: true })
        .some((d) => d.isDirectory() && d.name.toLowerCase().startsWith('funasr-') && d.name.toLowerCase().endsWith('.dist-info')))
  );
}

function sanitizeBasename(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 140);
}

function normalizePathForHydraValue(inputPath) {
  // Use forward slashes to avoid backslash escaping edge-cases in Hydra parsing.
  return process.platform === 'win32' ? inputPath.replace(/\\/g, '/') : inputPath;
}

function parseAsrResultFromOutput(output) {
  // FunASR CLI typically prints a python list with one dict, e.g.:
  //   [{'key': 'xxx', 'text': '...', 'timestamp': [[...], ...]}]
  // Key order may vary; extract the *last* match to avoid earlier logs/stats dicts.
  const re =
    /\{\s*[\s\S]*?'text'\s*:\s*'(?<text>[\s\S]*?)'\s*,\s*'timestamp'\s*:\s*(?<ts>\[\[[\s\S]*?\]\])[\s\S]*?\}/g;
  let match = null;
  for (const m of output.matchAll(re)) match = m;
  if (!match || !match.groups) {
    throw new Error(
      "Couldn't find FunASR result in stdout/stderr. Expected something like \"[{'text': '...', 'timestamp': [[...]]}]\"."
    );
  }

  const text = match.groups.text;
  const tsRaw = match.groups.ts;

  let timestamps = null;
  try {
    timestamps = JSON.parse(tsRaw);
  } catch {
    // Fallback: extract pairs manually.
    const pairs = [];
    const pairRe = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/g;
    for (const p of tsRaw.matchAll(pairRe)) pairs.push([Number(p[1]), Number(p[2])]);
    if (pairs.length === 0) throw new Error('Failed to parse timestamp list.');
    timestamps = pairs;
  }

  return { text, timestamps10ms: timestamps };
}

function isWhitespace(ch) {
  return /\s/u.test(ch);
}

function isCJK(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) // CJK Unified Ideographs Extension A
  );
}

function isAsciiWordChar(ch) {
  return /[A-Za-z0-9]/.test(ch);
}

function isPunctOrSymbol(ch) {
  try {
    return /[\p{P}\p{S}]/u.test(ch);
  } catch {
    // Older Node fallback.
    return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch);
  }
}

function buildWordLevelTimestamps(text, timestamps10ms) {
  // FunASR's `timestamp` often aligns to non-whitespace characters/tokens.
  // If lengths match, create word-level timing by grouping characters.
  const nonWsChars = [];
  for (const ch of text) if (!isWhitespace(ch)) nonWsChars.push(ch);

  if (timestamps10ms.length !== nonWsChars.length) {
    // Fallback: try 1:1 mapping between tokens (CJK chars + ascii words) and timestamps.
    const tokens = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (isWhitespace(ch) || isPunctOrSymbol(ch)) continue;
      if (isCJK(ch)) {
        tokens.push(ch);
        continue;
      }
      if (isAsciiWordChar(ch)) {
        let j = i;
        while (j < text.length && isAsciiWordChar(text[j])) j++;
        tokens.push(text.slice(i, j));
        i = j - 1;
        continue;
      }
      tokens.push(ch);
    }

    const n = Math.min(tokens.length, timestamps10ms.length);
    return {
      alignment: 'approx',
      words: Array.from({ length: n }, (_, idx) => ({
        word: tokens[idx],
        start: timestamps10ms[idx][0] / 100,
        end: timestamps10ms[idx][1] / 100,
        start10ms: timestamps10ms[idx][0],
        end10ms: timestamps10ms[idx][1],
      })),
    };
  }

  const words = [];
  let charIndex = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isWhitespace(ch)) continue;

    if (isPunctOrSymbol(ch)) {
      charIndex++;
      continue;
    }

    if (isCJK(ch)) {
      const [s, e] = timestamps10ms[charIndex];
      words.push({ word: ch, start: s / 100, end: e / 100, start10ms: s, end10ms: e });
      charIndex++;
      continue;
    }

    if (isAsciiWordChar(ch)) {
      const startCharIndex = charIndex;
      let j = i;
      while (j < text.length && isAsciiWordChar(text[j])) {
        j++;
      }
      // Advance charIndex by number of non-whitespace chars consumed.
      const rawWord = text.slice(i, j);
      for (let k = i; k < j; k++) if (!isWhitespace(text[k])) charIndex++;
      const endCharIndex = charIndex - 1;
      const [s] = timestamps10ms[startCharIndex];
      const [, e] = timestamps10ms[endCharIndex];
      words.push({ word: rawWord, start: s / 100, end: e / 100, start10ms: s, end10ms: e });
      i = j - 1;
      continue;
    }

    // Other letters/numbers: treat as single token.
    const [s, e] = timestamps10ms[charIndex];
    words.push({ word: ch, start: s / 100, end: e / 100, start10ms: s, end10ms: e });
    charIndex++;
  }

  return { alignment: 'char', words };
}

function formatSrtTime(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);

  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

function joinSubtitleTokens(words) {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const cur = words[i].word;
    const prev = i > 0 ? words[i - 1].word : '';
    const needsSpace = prev && /^[A-Za-z0-9]+$/.test(prev) && /^[A-Za-z0-9]+$/.test(cur);
    out += (needsSpace ? ' ' : '') + cur;
  }
  return out.trim();
}

function buildSrtCues(words) {
  // Heuristic cueing based on timing gaps + maximum duration/length.
  const maxCueDurationS = 5.0;
  const maxCueChars = 48;
  const gapBreakS = 0.6;

  const cues = [];
  let cur = [];
  let cueStart = null;
  let cueEnd = null;

  const flush = () => {
    if (cur.length === 0) return;
    const text = joinSubtitleTokens(cur);
    if (text) cues.push({ start: cueStart, end: cueEnd, text });
    cur = [];
    cueStart = null;
    cueEnd = null;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!cur.length) {
      cueStart = w.start;
      cueEnd = w.end;
      cur.push(w);
      continue;
    }

    const prev = words[i - 1];
    const gap = Math.max(0, w.start - prev.end);
    const nextText = joinSubtitleTokens([...cur, w]);
    const nextDuration = Math.max(0, w.end - cueStart);

    if (gap >= gapBreakS || nextDuration > maxCueDurationS || nextText.length > maxCueChars) {
      flush();
      cueStart = w.start;
      cueEnd = w.end;
      cur.push(w);
      continue;
    }

    cur.push(w);
    cueEnd = w.end;
  }
  flush();
  return cues;
}

function toSrt(cues) {
  return cues
    .map((c, idx) => {
      const start = formatSrtTime(c.start);
      const end = formatSrtTime(c.end);
      return `${idx + 1}\n${start} --> ${end}\n${c.text}\n`;
    })
    .join('\n');
}

async function main() {
  const audioPathArg = process.argv[2];
  if (!audioPathArg) usageAndExit();

  const baseDir = scriptDir();
  const audioPath = path.resolve(process.cwd(), audioPathArg);
  const audioForHydra = normalizePathForHydraValue(audioPath);

  const py = venvPythonPath(baseDir);
  const funasrExe = venvFunasrExePath(baseDir);

  const outBase = path.join(
    baseDir,
    `${sanitizeBasename(path.parse(audioPath).name)}.funasr`
  );
  const outRaw = `${outBase}.raw.txt`;
  const outTxt = `${outBase}.txt`;
  const outJson = `${outBase}.words.json`;
  const outSrt = `${outBase}.srt`;

  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };

  let cmd;
  let args;
  if (exists(funasrExe)) {
    cmd = funasrExe;
    args = [
      `+model=${MODEL_ASR}`,
      `+vad_model=${MODEL_VAD}`,
      `+punc_model=${MODEL_PUNC}`,
      `+input='${audioForHydra}'`,
    ];
  } else if (venvHasFunasrModule(baseDir)) {
    cmd = py;
    args = [
      '-u',
      '-m',
      'funasr.bin.inference',
      `+model=${MODEL_ASR}`,
      `+vad_model=${MODEL_VAD}`,
      `+punc_model=${MODEL_PUNC}`,
      `+input='${audioForHydra}'`,
    ];
  } else {
    // Fallback to PATH-installed funasr (common when funasr was installed globally).
    cmd = process.platform === 'win32' ? 'funasr.exe' : 'funasr';
    args = [
      `+model=${MODEL_ASR}`,
      `+vad_model=${MODEL_VAD}`,
      `+punc_model=${MODEL_PUNC}`,
      `+input='${audioForHydra}'`,
    ];
  }

  const child = spawn(cmd, args, { cwd: baseDir, env, windowsHide: true });

  let combined = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    combined += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    combined += chunk;
    process.stderr.write(chunk);
  });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  fs.writeFileSync(outRaw, combined, { encoding: 'utf8' });

  if (exitCode !== 0) {
    process.stderr.write(`\nFunASR failed (exit ${exitCode}). Raw log saved to: ${outRaw}\n`);
    process.exit(exitCode);
  }

  const { text, timestamps10ms } = parseAsrResultFromOutput(combined);
  fs.writeFileSync(outTxt, text, { encoding: 'utf8' });

  const { alignment, words } = buildWordLevelTimestamps(text, timestamps10ms);
  const payload = {
    audio: audioPath,
    model: { asr: MODEL_ASR, vad: MODEL_VAD, punc: MODEL_PUNC },
    alignment,
    text,
    words,
  };
  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), { encoding: 'utf8' });

  const srtCues = buildSrtCues(words);
  fs.writeFileSync(outSrt, toSrt(srtCues), { encoding: 'utf8' });

  process.stderr.write(`\nWrote:\n- ${outTxt}\n- ${outJson}\n- ${outSrt}\n- ${outRaw}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
