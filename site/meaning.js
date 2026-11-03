// Search by meaning. A small text model (all-MiniLM-L6-v2: 23 MB, fetched once and then kept by the browser)
// turns a few words into 384 numbers; photos whose words point the same way match even when they share no
// word ("children by the sea" finds "kids at the beach"). Lamhaat's window works out each photo's numbers
// before publishing (from its title, description, tags and what the AI saw); the site only has to work out
// the search's. Runs in the browser on WebAssembly: nothing is sent anywhere.
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs';
const MODEL = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx';
const VOCAB = new URL('./vendor/minilm-vocab.txt', import.meta.url).href;
export const DIMS = 384;

let ready = null;
function load() {
  ready ||= (async () => {
    const [ort, vocabText] = await Promise.all([import(ORT), fetch(VOCAB).then(r => r.text())]);
    ort.env.wasm.wasmPaths = ORT.replace(/[^/]+$/, '');
    ort.env.wasm.numThreads = 1; // no special page headers needed; one short sentence is quick on one thread
    const cache = await caches.open('lamhaat-models').catch(() => null);
    let res = await cache?.match(MODEL);
    if (!res) { res = await fetch(MODEL); if (!res.ok) throw new Error('The search model couldn’t be fetched.'); await cache?.put(MODEL, res.clone()); }
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
    const vocab = new Map(vocabText.split('\n').map((w, i) => [w.trim(), i]).filter(([w]) => w));
    return { ort, session, vocab };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// BERT's own way of cutting text into pieces: lower case, no accents, words and punctuation apart, then the
// longest pieces of each word that are in its list ("##" marks a piece that continues a word)
function tokens(text, vocab, max = 128) {
  const words = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
  const ids = [vocab.get('[CLS]')];
  for (const w of words) {
    let start = 0;
    const pieces = [];
    while (start < w.length) {
      let end = w.length, id;
      for (; end > start; end--) { id = vocab.get((start ? '##' : '') + w.slice(start, end)); if (id != null) break; }
      if (end === start) { pieces.length = 0; pieces.push(vocab.get('[UNK]')); break; }
      pieces.push(id); start = end;
    }
    ids.push(...pieces);
    if (ids.length >= max - 1) break;
  }
  ids.length = Math.min(ids.length, max - 1);
  ids.push(vocab.get('[SEP]'));
  return ids;
}

// the 384 numbers for a piece of text, made to length 1 (so comparing two is one sum)
export async function embed(text) {
  const { ort, session, vocab } = await load();
  const ids = tokens(text, vocab), n = ids.length;
  const t = (a) => new ort.Tensor('int64', BigInt64Array.from(a, BigInt), [1, n]);
  const out = await session.run({ input_ids: t(ids), attention_mask: t(ids.map(() => 1)), token_type_ids: t(ids.map(() => 0)) });
  const h = out.last_hidden_state.data, v = new Float32Array(DIMS);
  for (let i = 0; i < n; i++) for (let d = 0; d < DIMS; d++) v[d] += h[i * DIMS + d] / n; // the average over its pieces
  const len = Math.hypot(...v) || 1;
  return v.map(x => x / len);
}

// stored small: each number as a whole number from -127 to 127, in base64 (about 512 letters a photo)
export const pack = v => btoa(String.fromCharCode(...new Uint8Array(Int8Array.from(v, x => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer)));
export const unpack = s => { const b = atob(s), v = new Float32Array(b.length); for (let i = 0; i < b.length; i++) v[i] = ((b.charCodeAt(i) << 24) >> 24) / 127; return v; };
export const similarity = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// what a photo is about, in words: what its embedding is made from (the same on both sides)
export const photoText = p => [p.title, p.description ?? p.desc, ...(p.people || []), ...(p.tagNames || p.tags || []), p.aiDescription ?? p.ai?.d, ...((p.aiTags ?? p.ai?.t) || [])].filter(Boolean).join('. ');
