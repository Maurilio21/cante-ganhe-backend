import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const statePath = path.join(__dirname, "lyrics_feedback.json");
const genrePath = path.join(__dirname, "genre_references.json");

const vowels = "aeiouáàâãéêíóôõúü";
const accentedVowels = "áàâãéêíóôõúü";

const stopwords = new Set([
  "a",
  "o",
  "os",
  "as",
  "um",
  "uma",
  "uns",
  "umas",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "e",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "por",
  "para",
  "pra",
  "com",
  "sem",
  "que",
  "se",
  "eu",
  "tu",
  "ele",
  "ela",
  "nós",
  "vos",
  "eles",
  "elas",
  "me",
  "te",
  "se",
  "lhe",
  "lhes",
  "meu",
  "minha",
  "seu",
  "sua",
  "meus",
  "minhas",
  "seus",
  "suas",
  "num",
  "numa",
  "nuns",
  "numas",
  "ao",
  "aos",
  "à",
  "às",
  "há",
  "já",
  "não",
  "sim",
  "tá",
  "cê",
  "você",
  "vocês"
]);

const slangOutdated = ["maneiro", "da hora", "irado"];

const grammarPatterns = [
  {
    id: "grammar_pra_mim_fazer",
    label: "Uso incorreto de pronome após preposição",
    regex: /pra\s+mim\s+\w+|para\s+mim\s+\w+/i
  },
  {
    id: "grammar_a_gente_vamos",
    label: "Concordância com 'a gente'",
    regex: /a\s+gente\s+(vamos|fomos|iremos|cantamos)/i
  },
  {
    id: "grammar_os_problema",
    label: "Concordância nominal irregular",
    regex: /(os|as)\s+(problema|criança|pessoa|coisa|menina)\b/i
  },
  {
    id: "grammar_menos_eu",
    label: "Regência com 'menos eu'",
    regex: /menos\s+eu/i
  },
  {
    id: "grammar_ha_atras",
    label: "Redundância com há",
    regex: /há\s+\w+\s+atrás/i
  },
  {
    id: "grammar_menas",
    label: "Uso incorreto de 'menas'",
    regex: /\bmenas\b/i
  },
  {
    id: "grammar_seje",
    label: "Uso incorreto de 'seje'",
    regex: /\bseje\b/i
  },
  {
    id: "grammar_mais_melhor",
    label: "Comparativo redundante",
    regex: /mais\s+melhor|mais\s+pior|mais\s+menor/i
  }
];

const coherenceMarkers = [
  "refrão",
  "verso",
  "ponte",
  "pré-refrão",
  "pre-refrão",
  "intro",
  "outro"
];

const emotionLexicon = {
  positive: [
    "amor",
    "feliz",
    "alegria",
    "luz",
    "sorrir",
    "abraço",
    "paz",
    "calma",
    "esperança",
    "sonho"
  ],
  negative: [
    "dor",
    "saudade",
    "triste",
    "choro",
    "medo",
    "solidão",
    "raiva",
    "culpa",
    "vazio",
    "perda"
  ]
};

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-zà-ü\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ç/g, "c");
}

function getWords(line) {
  const clean = normalizeText(line);
  if (!clean) return [];
  return clean.split(" ").filter(Boolean);
}

function getLastWord(line) {
  const words = getWords(line);
  return words.length ? words[words.length - 1] : "";
}

function vowelGroupsWithIndex(word) {
  const groups = [];
  const regex = /[aeiouáàâãéêíóôõúü]+/gi;
  let match;
  while ((match = regex.exec(word))) {
    groups.push({
      start: match.index,
      end: match.index + match[0].length,
      value: match[0]
    });
  }
  return groups;
}

function detectStressGroupIndex(word) {
  const groups = vowelGroupsWithIndex(word);
  if (!groups.length) return 0;
  const lower = word.toLowerCase();
  const accentedIndex = (() => {
    for (let i = lower.length - 1; i >= 0; i -= 1) {
      if (accentedVowels.includes(lower[i])) return i;
    }
    return -1;
  })();
  if (accentedIndex >= 0) {
    const idx = groups.findIndex(
      (group) => accentedIndex >= group.start && accentedIndex < group.end
    );
    return idx >= 0 ? idx : groups.length - 1;
  }
  const normalized = removeAccents(lower);
  const endsWith = [
    "a",
    "e",
    "o",
    "as",
    "es",
    "os",
    "am",
    "em",
    "ens",
    "um",
    "uns",
    "im",
    "ins"
  ];
  const isParoxytone = endsWith.some((end) => normalized.endsWith(end));
  if (groups.length === 1) return 0;
  return isParoxytone ? Math.max(0, groups.length - 2) : groups.length - 1;
}

function syllableCount(word) {
  return vowelGroupsWithIndex(word).length || 1;
}

function isVowelChar(char) {
  return vowels.includes(char.toLowerCase());
}

function startsWithVowel(word) {
  if (!word) return false;
  const lower = word.toLowerCase();
  if (lower.startsWith("h") && lower.length > 1) {
    return isVowelChar(lower[1]);
  }
  return isVowelChar(lower[0]);
}

function endsWithVowel(word) {
  if (!word) return false;
  const lower = word.toLowerCase();
  return isVowelChar(lower[lower.length - 1]);
}

function countPoeticSyllables(line) {
  const words = getWords(line);
  if (!words.length) return 0;
  const syllables = words.map((word) => syllableCount(word));
  const stressIndexLast = detectStressGroupIndex(words[words.length - 1]);
  let total = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    total += syllables[i];
  }
  total += stressIndexLast + 1;
  for (let i = 0; i < words.length - 1; i += 1) {
    if (endsWithVowel(words[i]) && startsWithVowel(words[i + 1])) {
      total -= 1;
    }
  }
  return Math.max(total, 1);
}

function rhymeKey(word) {
  if (!word) return "";
  const clean = word.toLowerCase();
  const groups = vowelGroupsWithIndex(clean);
  if (!groups.length) return removeAccents(clean);
  const stressGroup = detectStressGroupIndex(clean);
  const start = groups[Math.max(0, stressGroup)].start;
  const slice = clean.slice(start);
  return removeAccents(slice).replace(/[^a-z]/g, "");
}

function rhymeVowelKey(word) {
  const key = rhymeKey(word);
  return key.replace(/[^aeiou]/g, "");
}

function guessPos(word) {
  const lower = removeAccents(word.toLowerCase());
  if (/(ar|er|ir)$/.test(lower)) return "verb";
  if (/(ando|endo|indo)$/.test(lower)) return "verb";
  if (/(ou|ei|ava|ia|ira|ira|aremos|eremos|iremos)$/.test(lower)) {
    return "verb";
  }
  if (/(mente)$/.test(lower)) return "adverb";
  if (/(cao|coes|sao|soes)$/.test(lower)) return "noun";
  if (/(dade|tude|agem|encia|ismo)$/.test(lower)) return "noun";
  if (/(oso|osa|ivel|avel|ico|ica|ado|ada)$/.test(lower)) return "adj";
  return "unknown";
}

function analyzeRhymes(lines) {
  const results = [];
  const endings = lines.map((line) => {
    const last = getLastWord(line);
    return {
      word: last,
      key: rhymeKey(last),
      vowelKey: rhymeVowelKey(last),
      pos: guessPos(last)
    };
  });
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = endings[i];
    const next = endings[i + 1];
    if (!current.word || !next.word) continue;
    const sameKey = current.key && current.key === next.key;
    const sameVowel =
      current.vowelKey && current.vowelKey === next.vowelKey;
    const type = sameKey
      ? "consonant"
      : sameVowel
      ? "assonant"
      : "none";
    const richness =
      current.pos !== "unknown" &&
      next.pos !== "unknown" &&
      current.pos !== next.pos
        ? "rich"
        : current.pos === next.pos && current.pos !== "unknown"
        ? "poor"
        : "neutral";
    results.push({
      lineIndex: i,
      nextLineIndex: i + 1,
      type,
      richness,
      words: [current.word, next.word]
    });
  }
  const keyCounts = new Map();
  endings.forEach((end) => {
    if (!end.key) return;
    keyCounts.set(end.key, (keyCounts.get(end.key) || 0) + 1);
  });
  const breaks = endings
    .map((end, idx) => ({ end, idx }))
    .filter(({ end }) => end.key && (keyCounts.get(end.key) || 0) === 1)
    .map(({ idx }) => idx);
  return { results, breaks };
}

function detectCacophony(line) {
  const compact = normalizeText(line).replace(/\s+/g, "");
  const risks = ["latinha", "mamão", "porcada", "bocadela"];
  return risks.filter((risk) => compact.includes(risk));
}

function detectAlliteration(line) {
  const words = getWords(line);
  if (words.length < 4) return false;
  const firstLetters = words
    .map((w) => w[0])
    .filter(Boolean)
    .join("");
  const repeats = firstLetters.match(/(.)\1{2,}/);
  return Boolean(repeats);
}

function extractKeywords(lines) {
  const freq = new Map();
  lines.forEach((line) => {
    getWords(line).forEach((word) => {
      if (stopwords.has(word)) return;
      const clean = removeAccents(word);
      freq.set(clean, (freq.get(clean) || 0) + 1);
    });
  });
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);
}

function computeEmotionScore(lines) {
  let score = 0;
  lines.forEach((line) => {
    const words = getWords(line).map((w) => removeAccents(w));
    words.forEach((word) => {
      if (emotionLexicon.positive.includes(word)) score += 1;
      if (emotionLexicon.negative.includes(word)) score -= 1;
    });
  });
  return score;
}

function sectionize(lyrics) {
  const lines = lyrics.split(/\r?\n/);
  const sections = [];
  let current = { name: "verso", lines: [] };
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      if (current.lines.length) {
        sections.push(current);
        current = { name: "verso", lines: [] };
      }
      return;
    }
    const lower = line.toLowerCase();
    const marker = coherenceMarkers.find((marker) =>
      lower.startsWith(marker)
    );
    if (marker) {
      if (current.lines.length) {
        sections.push(current);
      }
      current = { name: marker, lines: [] };
      return;
    }
    current.lines.push(line);
  });
  if (current.lines.length) sections.push(current);
  return sections;
}

function analyzeGrammar(lines) {
  const issues = [];
  lines.forEach((line, index) => {
    grammarPatterns.forEach((pattern) => {
      if (pattern.regex.test(line)) {
        issues.push({ id: pattern.id, lineIndex: index, label: pattern.label });
      }
    });
    slangOutdated.forEach((slang) => {
      if (new RegExp(`\\b${slang}\\b`, "i").test(line)) {
        issues.push({
          id: "slang_outdated",
          lineIndex: index,
          label: `Gíria desatualizada: ${slang}`
        });
      }
    });
  });
  return issues;
}

function analyzeMeter(sections) {
  const lineMetrics = [];
  sections.forEach((section, sectionIndex) => {
    section.lines.forEach((line, lineIndex) => {
      const count = countPoeticSyllables(line);
      lineMetrics.push({
        sectionIndex,
        lineIndex,
        syllables: count
      });
    });
  });
  const sectionStats = sections.map((section, idx) => {
    const syllables = lineMetrics
      .filter((metric) => metric.sectionIndex === idx)
      .map((metric) => metric.syllables);
    const avg =
      syllables.reduce((sum, value) => sum + value, 0) /
      Math.max(1, syllables.length);
    const variance =
      syllables.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
      Math.max(1, syllables.length);
    const std = Math.sqrt(variance);
    return { average: avg, std, syllables };
  });
  return { lineMetrics, sectionStats };
}

function analyzeCoherence(sections) {
  const results = sections.map((section) => {
    const keywords = extractKeywords(section.lines);
    const emotionScore = computeEmotionScore(section.lines);
    return { keywords, emotionScore };
  });
  const driftIssues = [];
  for (let i = 0; i < results.length - 1; i += 1) {
    const a = new Set(results[i].keywords);
    const b = new Set(results[i + 1].keywords);
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    const similarity = union.size ? intersection.size / union.size : 1;
    if (similarity < 0.15) {
      driftIssues.push({ index: i, nextIndex: i + 1, similarity });
    }
  }
  const emotionIssues = [];
  for (let i = 0; i < results.length - 1; i += 1) {
    const delta = Math.abs(
      results[i].emotionScore - results[i + 1].emotionScore
    );
    if (delta >= 4) {
      emotionIssues.push({ index: i, nextIndex: i + 1, delta });
    }
  }
  return { results, driftIssues, emotionIssues };
}

function analyzeCadence(sectionStats, genreConfig, timeSignature) {
  const issues = [];
  const range = genreConfig?.syllableRange || [6, 11];
  sectionStats.forEach((stat, index) => {
    stat.syllables.forEach((value) => {
      if (value < range[0] || value > range[1]) {
        issues.push({
          sectionIndex: index,
          syllables: value,
          expected: range
        });
      }
    });
  });
  if (genreConfig && !genreConfig.timeSignatures.includes(timeSignature)) {
    issues.push({
      type: "time_signature_mismatch",
      timeSignature
    });
  }
  return issues;
}

function aggregateIssues(ruleHits, id, count = 1) {
  ruleHits[id] = (ruleHits[id] || 0) + count;
}

function scoreFromIssues(base, issuesCount, weight = 10) {
  return Math.max(0, Math.min(100, base - issuesCount * weight));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--in") parsed.input = args[i + 1];
    if (arg === "--out") parsed.output = args[i + 1];
    if (arg === "--genre") parsed.genre = args[i + 1];
    if (arg === "--time") parsed.timeSignature = args[i + 1];
  }
  return parsed;
}

async function readInput() {
  const args = parseArgs();
  if (args.input) {
    const raw = fs.readFileSync(path.resolve(args.input), "utf-8");
    return { args, payload: JSON.parse(raw) };
  }
  const stdin = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
  if (stdin.trim().length) {
    return { args, payload: JSON.parse(stdin) };
  }
  return {
    args,
    payload: {
      title: "",
      lyrics: "",
      genre: "",
      timeSignature: "4/4"
    }
  };
}

export async function validateLyrics(payload, options = {}) {
  const genreOverride = options.genre;
  const timeOverride = options.timeSignature;
  const genreData = loadJson(genrePath, { genres: {} });
  const state = loadJson(statePath, {
    version: "1.0.0",
    totalRuns: 0,
    ruleHits: {},
    history: [],
    dynamicWeights: {}
  });

  const lyrics = payload.lyrics || "";
  const sections = sectionize(lyrics);
  const allLines = sections.flatMap((section) => section.lines);

  const rhymeIssues = [];
  const rhymeDetails = [];
  sections.forEach((section) => {
    const { results, breaks } = analyzeRhymes(section.lines);
    rhymeDetails.push({
      section: section.name,
      pairs: results
    });
    breaks.forEach((idx) => {
      rhymeIssues.push({
        section: section.name,
        lineIndex: idx,
        reason: "quebra_de_rima"
      });
    });
  });

  const meter = analyzeMeter(sections);
  const grammarIssues = analyzeGrammar(allLines);
  const coherence = analyzeCoherence(sections);

  const genreKey = (genreOverride || payload.genre || "").toLowerCase();
  const genreConfig = genreData.genres?.[genreKey] || null;
  const timeSignature = timeOverride || payload.timeSignature || "4/4";

  const cadenceIssues = analyzeCadence(
    meter.sectionStats,
    genreConfig,
    timeSignature
  );

  const cacophonyIssues = allLines.flatMap((line, index) => {
    const hits = detectCacophony(line);
    return hits.map((hit) => ({ lineIndex: index, hit }));
  });

  const alliterationIssues = allLines
    .map((line, index) => ({ index, hit: detectAlliteration(line) }))
    .filter((item) => item.hit)
    .map((item) => ({ lineIndex: item.index }));

  const meterVarianceIssues = meter.sectionStats
    .map((stat, idx) => ({ idx, std: stat.std }))
    .filter((stat) => stat.std > 1.5)
    .map((stat) => ({ sectionIndex: stat.idx, std: stat.std }));

  const ruleHits = {};
  rhymeIssues.forEach(() => aggregateIssues(ruleHits, "rhyme_break"));
  grammarIssues.forEach((issue) => aggregateIssues(ruleHits, issue.id));
  cadenceIssues.forEach((issue) =>
    aggregateIssues(
      ruleHits,
      issue.type || "meter_out_of_range"
    )
  );
  cacophonyIssues.forEach(() => aggregateIssues(ruleHits, "cacophony"));
  alliterationIssues.forEach(() => aggregateIssues(ruleHits, "alliteration"));
  meterVarianceIssues.forEach(() =>
    aggregateIssues(ruleHits, "meter_variance")
  );
  coherence.driftIssues.forEach(() =>
    aggregateIssues(ruleHits, "theme_drift")
  );
  coherence.emotionIssues.forEach(() =>
    aggregateIssues(ruleHits, "emotion_shift")
  );

  const grammarScore = scoreFromIssues(100, grammarIssues.length, 8);
  const rhymeScore = scoreFromIssues(100, rhymeIssues.length, 10);
  const musicalScore = scoreFromIssues(
    100,
    cadenceIssues.length + meterVarianceIssues.length,
    8
  );
  const themeScore = scoreFromIssues(
    100,
    coherence.driftIssues.length + coherence.emotionIssues.length,
    10
  );

  const totalScore =
    grammarScore * 0.3 +
    rhymeScore * 0.25 +
    musicalScore * 0.25 +
    themeScore * 0.2;

  Object.entries(ruleHits).forEach(([rule, count]) => {
    state.ruleHits[rule] = (state.ruleHits[rule] || 0) + count;
    if (state.ruleHits[rule] >= 20) {
      state.dynamicWeights[rule] = Math.min(
        0.3,
        (state.dynamicWeights[rule] || 0) + 0.05
      );
    }
  });
  state.totalRuns = (state.totalRuns || 0) + 1;
  state.history = state.history || [];
  state.history.push({
    timestamp: new Date().toISOString(),
    version: state.version,
    scores: {
      grammar: grammarScore,
      rhymes: rhymeScore,
      musical: musicalScore,
      theme: themeScore,
      total: Number(totalScore.toFixed(2))
    },
    genre: genreKey || null,
    timeSignature,
    issues: {
      grammar: grammarIssues.length,
      rhymes: rhymeIssues.length,
      musical: cadenceIssues.length + meterVarianceIssues.length,
      theme: coherence.driftIssues.length + coherence.emotionIssues.length
    }
  });

  saveJson(statePath, state);

  const report = {
    meta: {
      title: payload.title || "",
      genre: genreKey,
      timeSignature,
      generatedAt: new Date().toISOString()
    },
    sections: sections.map((section, index) => ({
      name: section.name,
      lines: section.lines,
      metrics: {
        averageSyllables: Number(
          meter.sectionStats[index]?.average.toFixed(2) || 0
        ),
        std: Number(meter.sectionStats[index]?.std.toFixed(2) || 0),
        syllables: meter.sectionStats[index]?.syllables || []
      }
    })),
    checks: {
      rhymes: {
        issues: rhymeIssues,
        pairs: rhymeDetails
      },
      meter: {
        varianceIssues: meterVarianceIssues,
        lineMetrics: meter.lineMetrics
      },
      grammar: {
        issues: grammarIssues
      },
      musicalAdherence: {
        cadenceIssues,
        timeSignature,
        genre: genreKey
      },
      coherence: {
        driftIssues: coherence.driftIssues,
        emotionIssues: coherence.emotionIssues,
        sectionKeywords: coherence.results.map((result) => result.keywords)
      },
      phonetics: {
        cacophonyIssues,
        alliterationIssues
      }
    },
    scores: {
      grammar: Number(grammarScore.toFixed(2)),
      rhymes: Number(rhymeScore.toFixed(2)),
      musical: Number(musicalScore.toFixed(2)),
      theme: Number(themeScore.toFixed(2)),
      total: Number(totalScore.toFixed(2))
    },
    protocol: {
      phase1: "validacao_automatica_concluida",
      phase2: "revisao_especialista_pendente",
      phase3: "teste_compositores_pendente"
    },
    feedback: {
      ruleHits,
      dynamicWeights: state.dynamicWeights
    }
  };

  const output = options.output ? path.resolve(options.output) : null;
  if (output) {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  return report;
}

async function runCLI() {
  const { args, payload } = await readInput();
  const report = await validateLyrics(payload, {
    genre: args.genre,
    timeSignature: args.timeSignature,
    output: args.output
  });
  process.stdout.write(JSON.stringify(report, null, 2));
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  runCLI();
}
