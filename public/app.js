// Jarvis — a voice assistant web app that talks to Claude.

const GREETING = 'Yes, sir. What are we doing today?';

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const micBtn = document.getElementById('mic');
const gate = document.getElementById('gate');
const gateBtn = document.getElementById('gate-btn');
const canvas = document.getElementById('orb');

const state = {
  config: { hasElevenLabs: false, model: '' },
  history: [],
  audioCtx: null,
  analyser: null,
  currentLevel: 0,
  speaking: false,
  usingAnalyser: false,
  listening: false,
  recognition: null,
};

// ---------- Bootstrap ----------

async function boot() {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch {
    // non-fatal — server may not be reachable yet
  }
  setStatus('Tap to wake Jarvis');
  setupVisualizer();
}

gateBtn.addEventListener('click', async () => {
  gate.classList.add('hidden');
  await ensureAudioContext();
  setStatus('Initializing…');
  await speak(GREETING);
  setStatus('Hold the mic, or just start speaking');
  setupRecognition();
});

micBtn.addEventListener('mousedown', startListening);
micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startListening(); });
micBtn.addEventListener('mouseup', stopListening);
micBtn.addEventListener('mouseleave', stopListening);
micBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopListening(); });

boot();

// ---------- UI helpers ----------

function setStatus(text) {
  statusEl.textContent = text;
}

function showExchange(userText, jarvisText) {
  transcriptEl.innerHTML = '';
  if (userText) {
    const u = document.createElement('span');
    u.className = 'user';
    u.textContent = `“${userText}”`;
    transcriptEl.appendChild(u);
  }
  if (jarvisText) {
    const j = document.createElement('span');
    j.textContent = jarvisText;
    transcriptEl.appendChild(j);
  }
}

// ---------- Audio ----------

async function ensureAudioContext() {
  if (state.audioCtx) return state.audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new Ctx();
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.analyser.smoothingTimeConstant = 0.8;
  state.analyser.connect(state.audioCtx.destination);
  return state.audioCtx;
}

async function speak(text) {
  if (!text) return;
  state.speaking = true;
  setStatus('Speaking…');

  try {
    if (state.config.hasElevenLabs) {
      await speakElevenLabs(text);
    } else {
      await speakBrowser(text);
    }
  } finally {
    state.speaking = false;
    state.currentLevel = 0;
    setStatus('Hold the mic, or just start speaking');
  }
}

async function speakElevenLabs(text) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    await speakBrowser(text);
    return;
  }
  const arrayBuf = await res.arrayBuffer();
  const ctx = await ensureAudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(state.analyser);

  state.usingAnalyser = true;
  try {
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    });
  } finally {
    state.usingAnalyser = false;
  }
}

function pickJarvisVoice() {
  const voices = speechSynthesis.getVoices();
  const prefs = [
    (v) => /en-GB/i.test(v.lang) && /male|daniel|arthur|oliver/i.test(v.name),
    (v) => /en-GB/i.test(v.lang),
    (v) => /daniel|arthur|oliver|google uk/i.test(v.name),
    (v) => /en[-_]?/i.test(v.lang),
  ];
  for (const pref of prefs) {
    const match = voices.find(pref);
    if (match) return match;
  }
  return voices[0];
}

async function speakBrowser(text) {
  if (!('speechSynthesis' in window)) return;

  // Voices load asynchronously on some browsers.
  if (speechSynthesis.getVoices().length === 0) {
    await new Promise((r) => {
      const t = setTimeout(r, 400);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); r(); }, { once: true });
    });
  }

  const utter = new SpeechSynthesisUtterance(text);
  const voice = pickJarvisVoice();
  if (voice) utter.voice = voice;
  utter.lang = (voice && voice.lang) || 'en-GB';
  utter.rate = 1.0;
  utter.pitch = 0.85;

  // Fake-but-believable amplitude while the browser speaks.
  let fakeLevel = 0;
  let speaking = true;
  const tick = () => {
    if (!speaking) return;
    fakeLevel = 0.35 + Math.abs(Math.sin(performance.now() / 140)) * 0.45;
    state.currentLevel = fakeLevel;
    requestAnimationFrame(tick);
  };
  tick();

  await new Promise((resolve) => {
    utter.onend = resolve;
    utter.onerror = resolve;
    speechSynthesis.speak(utter);
  });
  speaking = false;
}

// ---------- Speech recognition ----------

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus('Speech recognition not supported in this browser');
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;

  let finalText = '';

  rec.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    showExchange(finalText || interim, '');
  };

  rec.onerror = (e) => {
    console.warn('recognition error', e.error);
    micBtn.classList.remove('listening');
    state.listening = false;
  };

  rec.onend = async () => {
    micBtn.classList.remove('listening');
    state.listening = false;
    const text = finalText.trim();
    finalText = '';
    if (text) await handleUserMessage(text);
  };

  state.recognition = rec;
}

function startListening() {
  if (!state.recognition || state.listening || state.speaking) return;
  try {
    state.recognition.start();
    state.listening = true;
    micBtn.classList.add('listening');
    setStatus('Listening…');
  } catch {
    // start() throws if called while already running — ignore
  }
}

function stopListening() {
  if (!state.recognition || !state.listening) return;
  try { state.recognition.stop(); } catch { /* ignore */ }
}

// ---------- Chat ----------

async function handleUserMessage(text) {
  state.history.push({ role: 'user', content: text });
  setStatus('Thinking…');
  showExchange(text, '');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: state.history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    const reply = data.text || '…';
    state.history.push({ role: 'assistant', content: reply });
    showExchange(text, reply);
    await speak(reply);
  } catch (err) {
    const msg = `Apologies, sir — ${err.message}`;
    showExchange(text, msg);
    setStatus('Error');
    await speak(msg);
  }
}

// ---------- Visualizer ----------

function setupVisualizer() {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const freqData = new Uint8Array(256);

  function sampleLevel() {
    if (state.usingAnalyser && state.analyser) {
      state.analyser.getByteFrequencyData(freqData);
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const avg = sum / freqData.length / 255;
      state.currentLevel = Math.max(state.currentLevel * 0.85, avg * 1.4);
    } else if (!state.speaking) {
      state.currentLevel *= 0.92;
    }
    // when state.speaking && !usingAnalyser, the browser-TTS tick drives currentLevel directly
    return state.currentLevel;
  }

  function render(t) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const level = sampleLevel();

    const baseR = Math.min(w, h) * 0.18;
    const pulse = baseR * (1 + level * 0.35);

    // outer glow
    const glow = ctx.createRadialGradient(cx, cy, pulse * 0.4, cx, cy, pulse * 2.6);
    glow.addColorStop(0, `rgba(99, 210, 255, ${0.35 + level * 0.4})`);
    glow.addColorStop(0.4, 'rgba(99, 210, 255, 0.08)');
    glow.addColorStop(1, 'rgba(99, 210, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, pulse * 2.6, 0, Math.PI * 2);
    ctx.fill();

    // rotating rings
    const rings = 3;
    for (let i = 0; i < rings; i++) {
      const angle = (t / 4000) * (i % 2 === 0 ? 1 : -1) + (i * Math.PI) / 3;
      const rr = pulse * (1.25 + i * 0.22);
      ctx.strokeStyle = `rgba(99, 210, 255, ${0.18 + level * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr, rr * (0.55 + i * 0.12), angle, 0, Math.PI * 2);
      ctx.stroke();
    }

    // waveform blob
    ctx.beginPath();
    const segs = 180;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const n =
        Math.sin(a * 3 + t / 500) * 0.05 +
        Math.sin(a * 5 + t / 320) * 0.04 +
        Math.cos(a * 7 - t / 260) * 0.03;
      const r = pulse * (1 + n * (1 + level * 2));
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const core = ctx.createRadialGradient(cx, cy, pulse * 0.2, cx, cy, pulse * 1.1);
    core.addColorStop(0, `rgba(180, 235, 255, ${0.85})`);
    core.addColorStop(0.5, `rgba(99, 210, 255, ${0.55})`);
    core.addColorStop(1, 'rgba(99, 210, 255, 0.05)');
    ctx.fillStyle = core;
    ctx.fill();
    ctx.strokeStyle = `rgba(200, 240, 255, ${0.55 + level * 0.3})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}
