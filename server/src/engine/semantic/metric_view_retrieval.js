// Pure ranking helpers for metric-view retrieval candidates.

const METRIC_VIEW_ANCHOR_NGRAM_MIN = 3;
const METRIC_VIEW_ANCHOR_NGRAM_MAX = 8;
const EXPLICIT_TIME_KEYWORDS = [
  '年', '月', '日', '季度', 'q1', 'q2', 'q3', 'q4', '本月', '上月', '近', '最近', '同比', '环比',
];

function normalize_metric_view_text(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[\s\-_.,，。；;:：/\\()（）[\]{}]+/g, '');
  return normalized.replace(/的/g, '');
}

function has_metric_view_alias_exact_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const candidates = [match.name || ''];
  candidates.push(...(match.aliases || []));
  for (const candidate of candidates) {
    const normalizedCandidate = normalize_metric_view_text(candidate);
    if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
  }
  return false;
}

function _definition_field(definition, key) {
  if (_is_plain_object(definition)) return definition[key];
  return definition != null ? definition[key] : undefined;
}

function has_metric_view_dimension_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const queryDimensions = _definition_field(match.definition, 'query_dimensions') || [];
  for (const dimension of queryDimensions) {
    const allowedValues = (_is_plain_object(dimension) ? dimension.allowed_values : dimension?.allowed_values) || [];
    const paramType = _is_plain_object(dimension) ? dimension.param_type : dimension?.param_type;
    if (paramType !== 'discrete') continue;
    for (const candidate of allowedValues) {
      const normalizedCandidate = normalize_metric_view_text(String(candidate));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
    }
  }
  return false;
}

function extract_semantic_anchor_ngrams(text) {
  const normalizedText = normalize_metric_view_text(text);
  if (!normalizedText) return new Set();

  const anchors = new Set();
  const textLength = normalizedText.length;
  const maxNgram = Math.min(METRIC_VIEW_ANCHOR_NGRAM_MAX, textLength);
  for (let size = METRIC_VIEW_ANCHOR_NGRAM_MIN; size <= maxNgram; size += 1) {
    for (let start = 0; start <= textLength - size; start += 1) {
      const fragment = normalizedText.slice(start, start + size);
      if (/^[0-9a-z]+$/.test(fragment)) continue;
      anchors.add(fragment);
    }
  }
  return anchors;
}

function build_match_semantic_anchor_text(match) {
  const textParts = [match.name || '', match.description || ''];
  textParts.push(...(match.aliases || []));
  return textParts.filter((part) => part).join(' ');
}

function score_semantic_anchor_overlap(sharedAnchors, anchorDocumentFrequency) {
  let score = 0.0;
  for (const anchor of sharedAnchors) {
    const documentFrequency = anchorDocumentFrequency.get(anchor) || 1;
    score += (anchor.length ** 2) / documentFrequency;
  }
  return score;
}

function build_match_semantic_anchor_scores(question, matches) {
  const questionAnchors = extract_semantic_anchor_ngrams(question);
  const scores = {};
  if (questionAnchors.size === 0 || !matches.length) {
    matches.forEach((_match, index) => {
      scores[index] = 0.0;
    });
    return scores;
  }

  const sharedAnchorSets = {};
  const anchorDocumentFrequency = new Map();

  matches.forEach((match, index) => {
    const candidateAnchors = extract_semantic_anchor_ngrams(build_match_semantic_anchor_text(match));
    const sharedAnchors = new Set();
    for (const anchor of questionAnchors) {
      if (candidateAnchors.has(anchor)) sharedAnchors.add(anchor);
    }
    sharedAnchorSets[index] = sharedAnchors;
    for (const anchor of sharedAnchors) {
      anchorDocumentFrequency.set(anchor, (anchorDocumentFrequency.get(anchor) || 0) + 1);
    }
  });

  matches.forEach((_match, index) => {
    scores[index] = score_semantic_anchor_overlap(
      sharedAnchorSets[index] || new Set(),
      anchorDocumentFrequency,
    );
  });
  return scores;
}

function has_metric_view_fixed_value_match(question, match) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;

  const fixedPredicates = _definition_field(match.definition, 'fixed_predicates') || [];
  for (const predicate of fixedPredicates) {
    const kind = _is_plain_object(predicate) ? predicate.kind : predicate?.kind;
    const value = _is_plain_object(predicate) ? predicate.value : predicate?.value;
    const values = (_is_plain_object(predicate) ? predicate.values : predicate?.values) || [];

    if (kind === 'comparison' && value != null) {
      const normalizedCandidate = normalize_metric_view_text(String(value));
      if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
    }
    if (kind === 'set') {
      for (const candidate of values) {
        const normalizedCandidate = normalize_metric_view_text(String(candidate));
        if (normalizedCandidate && normalizedQuestion.includes(normalizedCandidate)) return true;
      }
    }
  }
  return false;
}

function question_has_explicit_time_constraint(question) {
  const normalizedQuestion = normalize_metric_view_text(question);
  if (!normalizedQuestion) return false;
  return EXPLICIT_TIME_KEYWORDS.some((keyword) =>
    normalizedQuestion.includes(normalize_metric_view_text(keyword)),
  );
}

function has_metric_view_time_dimension_match(question, match) {
  if (!question_has_explicit_time_constraint(question)) return false;
  const timeDimension = _definition_field(match.definition, 'time_dimension');
  return Boolean(timeDimension);
}

/**
 * prioritize_metric_view_matches —— 对召回的视图候选做多键稳定排序。
 * 与 view_metric_runtime.py 同名同序：alias 精确命中 > 语义锚点分 > 时间维度命中 >
 * 维度值命中 > 固定值命中 > similarity > 原始顺序（稳定）。
 */
export function prioritize_metric_view_matches(question, matches) {
  if (!matches || !matches.length) return [];

  const semanticAnchorScores = build_match_semantic_anchor_scores(question, matches);
  const indexed = matches.map((match, index) => ({ index, match }));

  // 构造可比较的元组（与 Python sort(key=..., reverse=True) 等价的降序比较）
  const sortKey = ({ index, match }) => [
    has_metric_view_alias_exact_match(question, match) ? 1 : 0,
    semanticAnchorScores[index] || 0.0,
    has_metric_view_time_dimension_match(question, match) ? 1 : 0,
    has_metric_view_dimension_value_match(question, match) ? 1 : 0,
    has_metric_view_fixed_value_match(question, match) ? 1 : 0,
    Number(match.similarity || 0.0),
    -index,
  ];

  indexed.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] > kb[i]) return -1;
      if (ka[i] < kb[i]) return 1;
    }
    return 0;
  });

  return indexed.map(({ match }) => match);
}
