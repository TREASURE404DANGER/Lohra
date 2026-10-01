// Runs one owner command through Gemini 3.8 Live with function calling. Text in, tool calls executed via `dispatch`, short text reply out.
// The model only ever gets the tool surface in _agenttools.js; sending still needs the owner's reaction (see agent.js).
import { session, GeminiError, scrub, cleanText, POLISH_MODEL } from './_gemini.js';

export async function runAgentCommand(text, { key, decls, system, dispatch, WS, log, timeoutMs = 90_000, maxCalls = 6 } = {}) {
  if (!key) throw new GeminiError('no API key', 'auth');
  const input = cleanText(text, 2000);
  if (!input) throw new GeminiError('empty command', 'skip');
  let out = '';
  let calls = 0;
  let busy = false;      // tool calls are running
  let sent = 0;          // tool responses sent so far
  let lastOut = 0;       // when the model last produced output (audio or transcript)
  let answered = false;  // the model has spoken since the last tool round (its turn ends right after a tool call, before our response)
  const trace = [];

  try {
  await session({
    key, WS, hardMs: timeoutMs,
    setup: {
      model: `models/${POLISH_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },   // the only mode this model supports; we keep the output transcription
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ functionDeclarations: decls }],
    },
    onReady: (ws) => ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: input }] }], turnComplete: true } })),
    onEvent: (m, ws, ctl) => {
      const fcs = m.toolCall?.functionCalls;
      if (fcs?.length) {
        calls += fcs.length;
        if (calls > maxCalls) return ctl.finish(new GeminiError('too many tool calls', 'rejected'));
        busy = true;
        out = '';   // anything said before a tool call is preamble
        answered = false;
        Promise.all(fcs.map(async (fc) => {
          let r;
          try { r = await dispatch(fc.name, fc.args || {}); } catch (e) { r = { ok: false, error: 'internal', message: e.message }; }
          trace.push({ tool: fc.name, ok: !!r?.ok, error: r?.error, status: r?.status });
          return { id: fc.id, name: fc.name, response: { output: r } };
        })).then((functionResponses) => {
          if (ctl.isDone()) return;
          busy = false; sent++; answered = false;
          ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
          const epoch = sent;
          ctl.after(() => { if (!busy && epoch === sent) ctl.finish(null, out); }, 25_000);   // model stayed silent after the tool: give up waiting
        }).catch((e) => ctl.finish(new GeminiError(scrub(e.message, key), 'internal')));
        return;
      }
      if (m.toolCallCancellation) return;
      const sc = m.serverContent;
      if (!sc) return;
      if (sc.interrupted) return ctl.finish(new GeminiError('generation interrupted', 'interrupted'));
      const t = sc.outputTranscription?.text;
      if (sc.modelTurn?.parts?.length || typeof t === 'string') { answered = true; lastOut = Date.now(); }
      if (typeof t === 'string') { out += t; if (out.length > 4000) return ctl.finish(new GeminiError('reply too long', 'rejected')); }
      if (sc.turnComplete) { if (!busy && (calls === 0 || answered)) ctl.finish(null, out); return; }
      if (sc.generationComplete) {
        const epoch = sent;
        // turnComplete trails by ~2 s; finish early only if no tool round is in flight and the model has answered
        ctl.after(() => { if (!busy && epoch === sent && (calls === 0 || answered) && Date.now() - lastOut >= 600) ctl.finish(null, out); }, 900);
      }
    },
  }).then((v) => { out = v ?? out; });
  } catch (e) { e.trace = trace; throw e; }   // the caller needs to know which tools already ran

  log?.info?.({ calls: trace.length, tools: trace.map((x) => x.tool) }, 'voice command finished');
  return { text: cleanText(out, 1000).replace(/\s+/g, ' '), trace };
}
