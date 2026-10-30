/* Flashcards engine: Anki-style spaced repetition + phone-first study UI.
   Plain script (no modules, no network). Exposes window.Flashcards = { mountReview, schedule }.
   Card types: 'mcq' (4 options), 'recall' (front/back), 'concept' (term + labelled sections). */
(function () {
  const MIN = 60e3, HOUR = 36e5, DAY = 864e5;
  const LEARN_STEPS = [1 * MIN, 10 * MIN];
  const RELEARN_STEPS = [10 * MIN];
  const GRADUATE_DAYS = 1, EASY_DAYS = 4, MAX_DAYS = 3650;
  const START_EASE = 2.5, MIN_EASE = 1.3;
  const LEARN_AHEAD = 20 * MIN;
  const ROLLOVER_HOUR = 4; // a review "day" starts at 4am, like Anki

  const GRADES = [
    { g: 1, key: 'again', label: 'Again' },
    { g: 2, key: 'hard', label: 'Hard' },
    { g: 3, key: 'good', label: 'Good' },
    { g: 4, key: 'easy', label: 'Easy' }
  ];

  /* ---------- time helpers ---------- */
  function dayStart(t) {
    const d = new Date(t - ROLLOVER_HOUR * HOUR);
    d.setHours(0, 0, 0, 0);
    return d.getTime() + ROLLOVER_HOUR * HOUR;
  }
  function dayKey(t) {
    const d = new Date(dayStart(t));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtIvl(ms) {
    if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
    if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
    const d = ms / DAY;
    if (d < 30) return `${Math.round(d)}d`;
    if (d < 365) return `${(d / 30).toFixed(d < 300 ? 1 : 0).replace(/\.0$/, '')}mo`;
    return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
  }

  /* ---------- scheduler (SM-2 style, Anki defaults) ---------- */
  function graduate(c, days, now) {
    c.q = 'review'; c.step = 0;
    c.ivl = Math.min(MAX_DAYS, Math.max(1, Math.round(days)));
    c.due = dayStart(now) + c.ivl * DAY;
  }
  // Returns the new card state after grading g (1 again, 2 hard, 3 good, 4 easy).
  function schedule(card, g, now = Date.now()) {
    const c = { q: 'new', ivl: 0, ease: START_EASE, step: 0, reps: 0, lapses: 0, due: 0, ...card };
    c.reps++;
    if (c.q === 'new') { c.q = 'learn'; c.step = 0; c.ease = START_EASE; }
    if (c.q === 'learn' || c.q === 'relearn') {
      const steps = c.q === 'relearn' ? RELEARN_STEPS : LEARN_STEPS;
      const step = Math.min(c.step, steps.length - 1);
      if (g === 1) { c.step = 0; c.due = now + steps[0]; }
      else if (g === 2) { c.step = step; c.due = now + (step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[step] * 1.5); }
      else if (g === 3) {
        if (step + 1 < steps.length) { c.step = step + 1; c.due = now + steps[c.step]; }
        else graduate(c, c.q === 'relearn' ? Math.max(1, c.ivl) : GRADUATE_DAYS, now);
      } else graduate(c, c.q === 'relearn' ? Math.max(1, c.ivl) + 1 : EASY_DAYS, now);
      return c;
    }
    const late = Math.max(0, (dayStart(now) - c.due) / DAY);
    if (g === 1) { // lapse
      c.lapses++;
      c.ease = Math.max(MIN_EASE, c.ease - 0.2);
      c.ivl = Math.max(1, Math.round(c.ivl * 0.2));
      c.q = 'relearn'; c.step = 0; c.due = now + RELEARN_STEPS[0];
      return c;
    }
    const hard = Math.max(c.ivl + 1, Math.round(c.ivl * 1.2));
    const good = Math.max(hard + 1, Math.round((c.ivl + late / 2) * c.ease));
    const easy = Math.max(good + 1, Math.round((c.ivl + late) * c.ease * 1.3));
    if (g === 2) c.ease = Math.max(MIN_EASE, c.ease - 0.15);
    if (g === 4) c.ease += 0.15;
    graduate(c, g === 2 ? hard : g === 3 ? good : easy, now);
    return c;
  }
  function previewMs(card, g, now) {
    const next = schedule(card, g, now);
    return next.q === 'review' ? next.ivl * DAY : next.due - now;
  }

  /* ---------- persistence (this device only; falls back to memory) ---------- */
  function createStore(key) {
    let mem = null;
    const blank = () => ({ v: 1, cards: {}, days: {}, settings: { newPerDay: 15 } });
    const load = () => {
      if (mem) return mem;
      try { mem = JSON.parse(localStorage.getItem(key)) || blank(); } catch (e) { mem = blank(); }
      mem.cards = mem.cards || {}; mem.days = mem.days || {}; mem.settings = { newPerDay: 15, ...(mem.settings || {}) };
      return mem;
    };
    const save = () => { try { localStorage.setItem(key, JSON.stringify(mem)); } catch (e) {} };
    return {
      get data() { return load(); },
      save,
      reset() { const settings = load().settings; mem = blank(); mem.settings = settings; save(); },
      exportCode() { return btoa(unescape(encodeURIComponent(JSON.stringify(load())))); },
      importCode(code) {
        const parsed = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
        if (!parsed || typeof parsed.cards !== 'object') throw new Error('Not a backup code');
        mem = { ...blank(), ...parsed }; save();
      }
    };
  }

  /* ---------- UI ---------- */
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }

  function mountReview(root, decks, opts = {}) {
    const cfg = {
      storageKey: 'flashcards.v1', appName: 'Review', kicker: 'Daily review · works offline',
      tagLabels: {}, highlight: esc, onSessionChange: null, ...opts
    };
    const store = createStore(cfg.storageKey);
    const tagLabel = t => cfg.tagLabels[t] || t;
    // Round-robin across decks, so "All decks" introduces new cards from every topic, not deck 1 first.
    const allCards = [];
    const deckOf = {};
    for (const d of decks) for (const c of d.cards) deckOf[c.id] = d;
    for (let i = 0, more = true; more; i++) {
      more = false;
      for (const d of decks) if (i < d.cards.length) { allCards.push(d.cards[i]); more = true; }
    }
    const state = id => store.data.cards[id] || { q: 'new' };
    let canSave = true;
    try { localStorage.setItem(cfg.storageKey + '.probe', '1'); canSave = localStorage.getItem(cfg.storageKey + '.probe') === '1'; localStorage.removeItem(cfg.storageKey + '.probe'); } catch (e) { canSave = false; }

    function today() {
      const k = dayKey(Date.now());
      const d = store.data.days;
      return (d[k] = d[k] || { reviews: 0, correct: 0, newSeen: 0 });
    }
    function streak() {
      const days = store.data.days;
      let n = 0, t = Date.now();
      if (!(days[dayKey(t)] && days[dayKey(t)].reviews)) t -= DAY; // today not done yet: count from yesterday
      while (days[dayKey(t)] && days[dayKey(t)].reviews) { n++; t -= DAY; }
      return n;
    }
    // The daily new-card limit is shared by all decks (like Anki's parent-deck limit).
    function newLeft() { return Math.max(0, store.data.settings.newPerDay + (today().extraNew || 0) - today().newSeen); }
    function counts(cards, now = Date.now()) {
      const end = dayStart(now) + DAY;
      let fresh = 0, learn = 0, due = 0;
      for (const c of cards) {
        const s = state(c.id);
        if (s.q === 'new') fresh++;
        else if (s.q === 'learn' || s.q === 'relearn') { if (s.due <= now + LEARN_AHEAD) learn++; }
        else if (s.due < end) due++;
      }
      return { fresh: Math.min(fresh, newLeft()), freshTotal: fresh, learn, due };
    }
    // Next card: learning cards that are due, then reviews due today, then new cards (daily cap).
    function nextCard(cards, now = Date.now()) {
      let bestLearn = null, bestReview = null, firstNewStudy = null, firstNewOther = null;
      const end = dayStart(now) + DAY;
      for (const c of cards) {
        const s = state(c.id);
        if (s.q === 'learn' || s.q === 'relearn') { if (s.due <= now && (!bestLearn || s.due < state(bestLearn.id).due)) bestLearn = c; }
        else if (s.q === 'review') { if (s.due < end && (!bestReview || s.due < state(bestReview.id).due)) bestReview = c; }
        else if (c.type === 'concept') { if (!firstNewStudy) firstNewStudy = c; }
        else if (!firstNewOther) firstNewOther = c;
      }
      // new cards alternate: a study card, then a question card, so neither kind is starved by the daily cap
      const firstNew = today().newSeen % 2 === 0 ? firstNewStudy || firstNewOther : firstNewOther || firstNewStudy;
      if (bestLearn) return bestLearn;
      if (bestReview) return bestReview;
      if (firstNew && newLeft() > 0) return firstNew;
      let ahead = null; // nothing else: allow learning cards due within the learn-ahead window
      for (const c of cards) {
        const s = state(c.id);
        if ((s.q === 'learn' || s.q === 'relearn') && s.due <= now + LEARN_AHEAD && (!ahead || s.due < state(ahead.id).due)) ahead = c;
      }
      return ahead;
    }
    function nextDueAt(cards) {
      let t = Infinity;
      for (const c of cards) { const s = state(c.id); if (s.q !== 'new' && s.due < t) t = s.due; }
      return t;
    }
    function countPills(k) {
      return `<span class="fc-n fc-new" title="New">${k.fresh}</span><span class="fc-n fc-learn" title="Learning">${k.learn}</span><span class="fc-n fc-due" title="Due">${k.due}</span>`;
    }
    function nextDueText(cards) {
      const t = nextDueAt(cards);
      if (!isFinite(t)) return 'No reviews scheduled yet.';
      const ms = t - Date.now();
      return ms <= 0 ? 'More cards are ready.' : `Next review in ${fmtIvl(ms)}.`;
    }
    const studyOnly = d => d && d.cards.every(c => c.type === 'concept');

    /* ----- home ----- */
    function renderHome() {
      closeSession();
      const all = counts(allCards);
      const t = today();
      const acc = t.reviews ? Math.round(t.correct / t.reviews * 100) : null;
      const learned = allCards.filter(c => state(c.id).q !== 'new').length;
      const mature = allCards.filter(c => state(c.id).ivl >= 21).length;
      const totalDue = all.fresh + all.learn + all.due;
      root.innerHTML = `
        <div class="fc-home">
          <section class="fc-hero">
            <div class="fc-hero-top"><div class="fc-kicker">${esc(cfg.kicker)}</div><button type="button" class="fc-gear" data-act="settings" aria-label="Settings and backup">⚙︎ Settings</button></div>
            <h1>${esc(cfg.appName)}</h1>
            ${learned ? '' : `<p class="fc-lead">${allCards.length} cards across ${decks.length} decks. Clear today's reviews first, then learn a few new cards. Five minutes a day beats an hour the night before.</p>`}
            ${canSave ? '' : `<p class="fc-warn">This viewer can't save progress between visits. Use Settings → Copy code before you close it.</p>`}
            <div class="fc-stats">
              <div><b>${streak()}</b><span>day streak</span></div>
              <div><b>${t.reviews}</b><span>reviews today</span></div>
              <div><b>${acc === null ? '–' : acc + '%'}</b><span>pass rate today</span></div>
              <div><b>${learned}</b><span>cards started</span></div>
            </div>
            <button type="button" class="fc-btn fc-primary fc-study" data-act="study" ${totalDue ? '' : 'disabled'}>
              ${totalDue ? `Study now <span class="fc-counts">${countPills(all)}</span>` : 'All caught up for today ✓'}
            </button>
            ${totalDue ? '' : `<p class="fc-sub">${nextDueText(allCards)}</p><div class="fc-row fc-more"><button type="button" class="fc-btn fc-ghost" data-act="more-new">Learn 10 more</button><button type="button" class="fc-btn fc-ghost" data-act="quiz">Quick quiz</button></div>`}
          </section>

          <section class="fc-decks" aria-label="Decks">
            <div class="fc-section-h"><h2>Decks</h2><span class="fc-legend"><span class="fc-n fc-new">New</span><span class="fc-n fc-learn">Learning</span><span class="fc-n fc-due">Due</span></span></div>
            <p class="fc-sub fc-limit-note">${newLeft()} of ${store.data.settings.newPerDay + (t.extraNew || 0)} new cards left today, shared across decks.</p>
            <ul>${decks.map((d, i) => {
              // Decks with a `section` label group under it; otherwise fall back to study/practice grouping.
              const head = d.section ? (i === 0 || decks[i - 1].section !== d.section ? `<li class="fc-subhead fc-section-head">${esc(d.section)}</li>` : '')
                : i === 0 && studyOnly(d) ? '<li class="fc-subhead">Study cards · flip and recall</li>'
                : (!studyOnly(d) && (i === 0 || studyOnly(decks[i - 1])) ? '<li class="fc-subhead">Practice decks · questions</li>' : '');
              const k = counts(d.cards);
              const started = d.cards.filter(c => state(c.id).q !== 'new').length;
              const pct = Math.round(started / d.cards.length * 100);
              const idle = !(k.fresh + k.learn + k.due);
              return `${head}<li class="fc-deck${idle ? ' is-idle' : ''}">
                <button type="button" class="fc-deck-main" data-act="study" data-deck="${d.id}">
                  <span class="fc-deck-emoji" aria-hidden="true">${d.emoji}</span>
                  <span class="fc-deck-text"><span class="fc-deck-name">${esc(d.name)}</span><span class="fc-deck-blurb">${esc(d.blurb)}</span>
                    <span class="fc-bar" aria-label="${pct}% started"><span style="width:${pct}%"></span></span></span>
                  ${idle ? '<span class="fc-idle">✓ Done</span>' : `<span class="fc-counts">${countPills(k)}</span>`}
                </button>
                <span class="fc-side-btns">${d.cards.some(c => c.type === 'mcq') ? `<button type="button" class="fc-quiz-btn" data-act="quiz" data-deck="${d.id}" aria-label="Quiz: ${esc(d.name)}">Quiz</button>` : ''}<button type="button" class="fc-quiz-btn" data-act="browse" data-deck="${d.id}" aria-label="Browse: ${esc(d.name)}">Browse</button></span>
              </li>`;
            }).join('')}</ul>
            <button type="button" class="fc-btn fc-ghost fc-quiz-all" data-act="quiz">Mixed quiz · 15 random questions</button>
          </section>

          <details class="fc-panel">
            <summary>How to review</summary>
            <ol class="fc-rules">
              <li><strong>Never skip a day.</strong> Reviews pile up fast. Five minutes on the train beats an hour the night before.</li>
              <li><strong>Reviews before new cards.</strong> Study now always clears what's due first, then adds new cards.</li>
              <li><strong>Grade honestly.</strong> A wrong answer always counts as Again. Right but slow? Hard. Right with a little thought? Good. Instant? Easy.</li>
              <li><strong>Say answers out loud.</strong> Interviews are spoken. Saying the answer before you flip is the closest practice to the real thing.</li>
              <li><strong>Read the explanation on every miss.</strong> The "why" is the lesson. The card comes back in minutes.</li>
            </ol>
            <p class="fc-sub">Intervals grow each time you remember: 1 minute → 10 minutes → 1 day → 3 days → a week and beyond. Forgotten cards drop back into short steps.</p>
          </details>

          <details class="fc-panel" id="fc-settings">
            <summary>Settings & backup</summary>
            <div class="fc-setting">
              <span>New cards per day <small>(all decks)</small></span>
              <span class="fc-stepper"><button type="button" data-act="new-minus" aria-label="Fewer new cards">−</button><b data-new-limit>${store.data.settings.newPerDay}</b><button type="button" data-act="new-plus" aria-label="More new cards">+</button></span>
            </div>
            <p class="fc-sub">Progress is saved on this device only. ${learned} started · ${mature} mature (21+ day interval). To move progress to another device, copy a backup code here and restore it there.</p>
            <div class="fc-row"><button type="button" class="fc-btn fc-ghost" data-act="backup">Copy code</button><button type="button" class="fc-btn fc-ghost" data-act="restore-open">Restore</button></div>
            <div class="fc-msg" aria-live="polite"></div>
            <div class="fc-restore" hidden>
              <textarea id="fc-restore-input" rows="3" placeholder="Paste a backup code" aria-label="Backup code"></textarea>
              <button type="button" class="fc-btn fc-primary" data-act="restore">Restore progress</button>
            </div>
            <button type="button" class="fc-link-danger" data-act="reset">Reset all review progress</button>
          </details>
        </div>`;
    }

    /* ----- session overlay ----- */
    let session = null;
    function openOverlay() {
      let ov = document.querySelector('.fc-session');
      if (!ov) {
        ov = document.createElement('div');
        ov.className = 'fc-session';
        ov.setAttribute('role', 'dialog');
        ov.setAttribute('aria-modal', 'true');
        document.body.appendChild(ov);
      }
      document.documentElement.classList.add('fc-locked');
      // a history entry, so an iOS back-swipe ends the session instead of leaving the page
      if (!(history.state && history.state.fcSession)) { try { history.pushState({ fcSession: true }, ''); } catch (e) {} }
      cfg.onSessionChange && cfg.onSessionChange(true);
      return ov;
    }
    function exitSession() {
      if (history.state && history.state.fcSession) history.back(); // popstate renders home
      else renderHome();
    }
    function closeSession() {
      session = null;
      const ov = document.querySelector('.fc-session');
      if (ov) ov.remove();
      document.documentElement.classList.remove('fc-locked');
      cfg.onSessionChange && cfg.onSessionChange(false);
    }
    function shell(ov, { title, right = '', progress = 0 }) {
      ov.innerHTML = `
        <div class="fc-top">
          <button type="button" class="fc-x" data-act="exit" aria-label="End session">✕</button>
          <div class="fc-top-title">${esc(title)}</div>
          <div class="fc-top-right">${right}</div>
        </div>
        <div class="fc-progress"><span style="width:${Math.round(progress * 100)}%"></span></div>
        <div class="fc-scroll"><article class="fc-card"></article></div>
        <div class="fc-actions"></div>`;
      return { card: ov.querySelector('.fc-card'), actions: ov.querySelector('.fc-actions'), scroll: ov.querySelector('.fc-scroll') };
    }

    const QUEUE_LABEL = { new: 'New', learn: 'Learning', relearn: 'Relearning', review: 'Review' };
    function cardBody(c, order, queue) {
      const d = deckOf[c.id];
      const tag = `<div class="fc-meta"><span class="fc-tags"><span class="fc-tag fc-tag-${esc(c.tag || 'card')}">${esc(tagLabel(c.tag || 'card'))}</span>${queue ? `<span class="fc-queue fc-queue-${queue}">${QUEUE_LABEL[queue]}</span>` : ''}</span><span class="fc-deckname">${d.emoji} ${esc(d.name)}</span></div>`;
      const code = c.code ? `<pre class="fc-code"><code>${cfg.highlight(c.code.trim())}</code></pre>` : '';
      const src = c.source ? `<div class="fc-source">Source: ${c.source}${c.asOf ? ` · as of ${esc(c.asOf)}` : ''}</div>` : '';
      if (c.type === 'recall') return `${tag}<div class="fc-q">${c.front}</div>${code}<div class="fc-back" hidden>${c.back}${src}</div>`;
      if (c.type === 'concept') {
        const sections = c.sections || [];
        return `${tag}<div class="fc-term">${esc(c.term)}</div>
          <p class="fc-term-prompt">${esc(c.prompt || 'Say it out loud before you flip:')}</p>
          <ul class="fc-term-hints">${sections.map(([label]) => `<li>${esc(label)}</li>`).join('')}</ul>
          <div class="fc-back fc-concept" hidden>
            ${sections.map(([label, html]) => `<div class="fc-cx-row"><div class="fc-cx-label">${esc(label)}</div><div class="fc-cx-val">${html}</div></div>`).join('')}${src}
          </div>`;
      }
      return `${tag}<div class="fc-q">${c.q}</div>${code}
        <div class="fc-options" role="group" aria-label="Answers">${order.map((oi, i) =>
          `<button type="button" class="fc-opt" data-opt="${oi}"><span class="fc-opt-k">${i + 1}</span><span class="fc-opt-t">${c.options[oi]}</span></button>`).join('')}</div>
        <div class="fc-why" hidden></div>`;
    }

    /* ----- study (scheduled) ----- */
    function startStudy(deckId) {
      const deck = deckId && decks.find(d => d.id === deckId);
      session = { mode: 'study', cards: deck ? deck.cards : allCards, deckId, title: deck ? deck.name : 'All decks', done: 0 };
      showNext();
    }
    function showNext(forced, keepOrder) {
      const ov = openOverlay();
      const s = session;
      const c = forced || nextCard(s.cards);
      const k = counts(s.cards);
      if (!c) return showDone(ov);
      s.current = c;
      s.revealed = false;
      s.order = keepOrder || (c.type === 'mcq' ? shuffle([0, 1, 2, 3]) : null);
      const st = state(c.id);
      const remaining = k.fresh + k.learn + k.due;
      const { card, actions, scroll } = shell(ov, {
        title: s.title,
        right: `${s.undo ? '<button type="button" class="fc-undo" data-act="undo" aria-label="Undo last answer">↶ Undo</button>' : ''}<span class="fc-counts">${countPills(k)}</span>`,
        progress: s.done / (s.done + remaining || 1)
      });
      card.innerHTML = cardBody(c, s.order, st.q);
      scroll.scrollTop = 0;
      s.shownAt = Date.now();
      actions.innerHTML = c.type !== 'mcq'
        ? '<button type="button" class="fc-btn fc-primary fc-wide" data-act="show">Show answer</button>'
        : '<p class="fc-hint">Pick an answer</p>';
    }
    function reveal(chosen) {
      const s = session;
      if (!s || s.revealed) return;
      const c = s.current;
      s.revealed = true;
      const ov = document.querySelector('.fc-session');
      const actions = ov.querySelector('.fc-actions');
      let correct = true;
      if (c.type === 'mcq') {
        correct = chosen === c.answer;
        ov.querySelectorAll('.fc-opt').forEach(b => {
          const oi = +b.dataset.opt;
          b.disabled = true;
          b.classList.add(oi === c.answer ? 'is-correct' : oi === chosen ? 'is-wrong' : 'is-dim');
        });
        const why = ov.querySelector('.fc-why');
        why.hidden = false;
        why.innerHTML = `<div class="fc-verdict ${correct ? 'ok' : 'no'}">${correct ? '✓ Correct' : '✗ Not quite'}</div>${c.why}${c.source ? `<div class="fc-source">Source: ${c.source}${c.asOf ? ` · as of ${esc(c.asOf)}` : ''}</div>` : ''}`;
        requestAnimationFrame(() => why.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      } else {
        ov.querySelector('.fc-back').hidden = false;
      }
      const st = state(c.id), now = Date.now();
      // honest grading: a wrong multiple-choice answer can only be "Again", and a slow first answer can't be "Easy"
      let grades = c.type === 'mcq' && !correct ? GRADES.slice(0, 1) : GRADES;
      if (c.type === 'mcq' && correct && st.q === 'new' && now - s.shownAt > 8000) grades = GRADES.slice(0, 3);
      actions.innerHTML = `<div class="fc-grades${grades.length === 1 ? ' single' : ''}">${grades.map(x =>
        `<button type="button" class="fc-grade fc-${x.key}" data-grade="${x.g}"><span>${x.label}</span><small>${fmtIvl(previewMs(st, x.g, now))}</small></button>`).join('')}</div>`;
    }
    function grade(g) {
      const s = session;
      if (!s || !s.revealed) return;
      const c = s.current;
      const t = today();
      const before = state(c.id);
      s.undo = { card: c, order: s.order, prev: store.data.cards[c.id], day: { ...t } };
      if (before.q === 'new') t.newSeen++;
      t.reviews++;
      if (g > 1) t.correct++;
      store.data.cards[c.id] = schedule(before, g, Date.now());
      store.save();
      s.done++;
      showNext();
    }
    function showDone(ov) {
      const s = session;
      const t = today();
      const { card, actions } = shell(ov, { title: s.title, progress: 1 });
      card.classList.add('fc-done');
      card.innerHTML = `<div class="fc-done-emoji" aria-hidden="true">🏁</div>
        <h2>${s.done ? 'Session complete' : 'Nothing due right now'}</h2>
        <p>${s.done ? `You reviewed ${s.done} card${s.done === 1 ? '' : 's'} this session.` : 'No cards are due and no new cards are left for today.'}</p>
        <div class="fc-stats small">
          <div><b>${streak()}</b><span>day streak</span></div>
          <div><b>${t.reviews}</b><span>today</span></div>
          <div><b>${t.reviews ? Math.round(t.correct / t.reviews * 100) + '%' : '–'}</b><span>correct</span></div>
        </div>
        <p class="fc-sub">${nextDueText(s.cards)}</p>`;
      actions.innerHTML = `<div class="fc-row">${newLeft() === 0 && s.cards.some(c => state(c.id).q === 'new') ? '<button type="button" class="fc-btn fc-ghost" data-act="more-new">Learn 10 more</button>' : ''}<button type="button" class="fc-btn fc-ghost" data-act="quiz-from-done">${s.deckId ? 'Quiz this deck' : 'Take a quiz'}</button><button type="button" class="fc-btn fc-primary" data-act="exit">Done</button></div>`;
    }

    /* ----- browse: flip through a deck in order, no grading, nothing saved ----- */
    function startBrowse(deckId) {
      const d = decks.find(x => x.id === deckId);
      session = { mode: 'browse', cards: d.cards, i: 0, title: `Browse · ${d.name}` };
      showBrowse();
    }
    function showBrowse() {
      const ov = openOverlay();
      const s = session;
      const c = s.current = s.cards[s.i];
      s.revealed = false;
      s.order = c.type === 'mcq' ? shuffle([0, 1, 2, 3]) : null;
      const { card, actions, scroll } = shell(ov, { title: s.title, right: `<span class="fc-quiz-pos">${s.i + 1}/${s.cards.length}</span>`, progress: (s.i + 1) / s.cards.length });
      card.innerHTML = cardBody(c, s.order);
      card.querySelectorAll('.fc-opt').forEach(b => { b.disabled = true; b.classList.add('is-inert'); });
      scroll.scrollTop = 0;
      actions.innerHTML = '<div class="fc-browse-bar"><button type="button" class="fc-btn fc-ghost" data-act="b-prev" aria-label="Previous card">‹</button><button type="button" class="fc-btn fc-primary" data-act="flip">Flip</button><button type="button" class="fc-btn fc-ghost" data-act="b-next" aria-label="Next card">›</button></div>';
    }
    function browseFlip() {
      const s = session;
      if (!s || s.mode !== 'browse') return;
      const c = s.current;
      const ov = document.querySelector('.fc-session');
      if (s.revealed) { showBrowse(); return; }
      s.revealed = true;
      if (c.type === 'mcq') {
        ov.querySelectorAll('.fc-opt').forEach(b => { const ok = +b.dataset.opt === c.answer; b.classList.add(ok ? 'is-correct' : 'is-dim'); if (ok) b.querySelector('.fc-opt-k').textContent = '✓'; });
        const why = ov.querySelector('.fc-why'); why.hidden = false; why.innerHTML = c.why;
      } else ov.querySelector('.fc-back').hidden = false;
      ov.querySelector('[data-act="flip"]').textContent = 'Hide';
    }

    /* ----- quiz: multiple choice only, no scheduling ----- */
    function startQuiz(deckId) {
      const pool = (deckId ? decks.find(d => d.id === deckId).cards : allCards).filter(c => c.type === 'mcq');
      if (deckId && !pool.length) return startQuiz(); // study-only deck: fall back to a mixed quiz
      if (!pool.length) return;
      const qs = shuffle(pool).slice(0, deckId ? Math.min(10, pool.length) : 15);
      session = { mode: 'quiz', qs, i: 0, score: 0, missed: [], title: `Quiz · ${deckId ? decks.find(d => d.id === deckId).name : 'Mixed'}` };
      showQuiz();
    }
    function showQuiz() {
      const ov = openOverlay();
      const s = session;
      if (s.i >= s.qs.length) return showQuizEnd(ov);
      const c = s.current = s.qs[s.i];
      s.revealed = false;
      s.order = shuffle([0, 1, 2, 3]);
      const { card, actions, scroll } = shell(ov, { title: s.title, right: `<span class="fc-quiz-pos">${s.i + 1}/${s.qs.length}</span>`, progress: s.i / s.qs.length });
      card.innerHTML = cardBody(c, s.order);
      scroll.scrollTop = 0;
      actions.innerHTML = '<p class="fc-hint">Pick an answer</p>';
    }
    function quizReveal(chosen) {
      const s = session, c = s.current;
      if (s.revealed) return;
      s.revealed = true;
      const ov = document.querySelector('.fc-session');
      const ok = chosen === c.answer;
      if (ok) s.score++; else s.missed.push({ c, chosen });
      ov.querySelectorAll('.fc-opt').forEach(b => {
        const oi = +b.dataset.opt; b.disabled = true;
        b.classList.add(oi === c.answer ? 'is-correct' : oi === chosen ? 'is-wrong' : 'is-dim');
      });
      const why = ov.querySelector('.fc-why');
      why.hidden = false;
      why.innerHTML = `<div class="fc-verdict ${ok ? 'ok' : 'no'}">${ok ? '✓ Correct' : '✗ Not quite'}</div>${c.why}`;
      requestAnimationFrame(() => why.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      ov.querySelector('.fc-actions').innerHTML = `<button type="button" class="fc-btn fc-primary fc-wide" data-act="quiz-next">${s.i + 1 < s.qs.length ? 'Next question' : 'See results'}</button>`;
    }
    function showQuizEnd(ov) {
      const s = session;
      const pct = Math.round(s.score / s.qs.length * 100);
      const { card, actions } = shell(ov, { title: s.title, progress: 1 });
      card.classList.add('fc-done');
      card.innerHTML = `<div class="fc-done-emoji" aria-hidden="true">${pct === 100 ? '🏆' : pct >= 70 ? '🎯' : '📚'}</div>
        <h2>${s.score} / ${s.qs.length} correct</h2>
        <p>${pct === 100 ? 'Flawless.' : pct >= 70 ? 'Solid. Review the misses below.' : 'These need work. Tap Redo misses to drill them now.'}</p>
        ${s.missed.length ? `<ul class="fc-missed">${s.missed.map(({ c, chosen }) => `<li><details><summary><div class="fc-missed-q">${c.q}</div><div class="fc-missed-a">Answer: ${c.options[c.answer]}</div><div class="fc-missed-you">You picked: ${c.options[chosen]}</div></summary><div class="fc-missed-why">${c.why}</div></details></li>`).join('')}</ul>` : ''}`;
      actions.innerHTML = `<div class="fc-row">${s.missed.length ? '<button type="button" class="fc-btn fc-ghost" data-act="queue-missed">Redo misses</button>' : ''}<button type="button" class="fc-btn fc-primary" data-act="exit">Done</button></div>`;
    }
    function queueMissed() {
      const now = Date.now();
      for (const { c } of session.missed) {
        const st = state(c.id);
        store.data.cards[c.id] = st.q === 'new' ? schedule(st, 1, now - LEARN_STEPS[0]) : { ...st, due: Math.min(st.due, now), q: st.q === 'review' ? 'relearn' : st.q, step: 0 };
      }
      store.save();
      const missedIds = new Set(session.missed.map(m => m.c.id));
      session = { mode: 'study', cards: allCards.filter(c => missedIds.has(c.id)), title: 'Missed questions', done: 0 };
      showNext();
    }

    /* ----- events ----- */
    function openPanel(i) { const p = root.querySelectorAll('.fc-panel')[i]; if (p) p.open = true; }
    function onClick(e) {
      const t = e.target.closest('[data-act], [data-opt], [data-grade]');
      if (!t) return;
      if (t.dataset.opt !== undefined) {
        if (!session || session.mode === 'browse') return;
        return session.mode === 'quiz' ? quizReveal(+t.dataset.opt) : reveal(+t.dataset.opt);
      }
      if (t.dataset.grade) return grade(+t.dataset.grade);
      const act = t.dataset.act;
      const msg = root.querySelector('.fc-msg');
      switch (act) {
        case 'study': startStudy(t.dataset.deck); break;
        case 'settings': { const p = root.querySelector('#fc-settings'); p.open = true; p.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
        case 'more-new': today().extraNew = (today().extraNew || 0) + 10; store.save(); if (session) showNext(); else startStudy(); break;
        case 'quiz': startQuiz(t.dataset.deck); break;
        case 'browse': startBrowse(t.dataset.deck); break;
        case 'flip': browseFlip(); break;
        case 'b-next': session.i = (session.i + 1) % session.cards.length; showBrowse(); break;
        case 'b-prev': session.i = (session.i - 1 + session.cards.length) % session.cards.length; showBrowse(); break;
        case 'quiz-from-done': startQuiz((session && session.deckId) || undefined); break;
        case 'show': reveal(); break;
        case 'quiz-next': session.i++; showQuiz(); break;
        case 'queue-missed': queueMissed(); break;
        case 'exit': exitSession(); break;
        case 'undo': {
          const u = session && session.undo;
          if (!u) break;
          if (u.prev) store.data.cards[u.card.id] = u.prev; else delete store.data.cards[u.card.id];
          store.data.days[dayKey(Date.now())] = u.day;
          store.save();
          session.undo = null;
          session.done = Math.max(0, session.done - 1);
          showNext(u.card, u.order);
          break;
        }
        case 'new-minus': case 'new-plus': {
          const s = store.data.settings;
          s.newPerDay = Math.max(0, Math.min(100, s.newPerDay + (act === 'new-plus' ? 5 : -5)));
          store.save();
          root.querySelector('[data-new-limit]').textContent = s.newPerDay; // update in place so the stepper doesn't jump
          const note = root.querySelector('.fc-limit-note');
          if (note) note.textContent = `${newLeft()} of ${s.newPerDay + (today().extraNew || 0)} new cards left today, shared across decks.`;
          break;
        }
        case 'backup': {
          const code = store.exportCode();
          const done = ok => {
            msg.textContent = ok ? 'Backup code copied. Paste it into Restore on your other device.' : 'Copy this code:';
            if (!ok) { const ta = root.querySelector('#fc-restore-input'); root.querySelector('.fc-restore').hidden = false; ta.value = code; ta.select(); }
          };
          try { navigator.clipboard.writeText(code).then(() => done(true), () => done(false)); } catch (err) { done(false); }
          break;
        }
        case 'restore-open': root.querySelector('.fc-restore').hidden = false; root.querySelector('#fc-restore-input').focus(); break;
        case 'restore': {
          const input = root.querySelector('#fc-restore-input').value;
          if (!t.dataset.armed) {
            let n;
            try { n = Object.keys(JSON.parse(decodeURIComponent(escape(atob(input.trim())))).cards || {}).length; }
            catch (err) { msg.textContent = 'That code did not work. Copy the whole backup code and try again.'; break; }
            t.dataset.armed = '1';
            t.textContent = `Replace ${Object.keys(store.data.cards).length} cards here with ${n} from the code?`;
            break;
          }
          try { store.importCode(input); renderHome(); openPanel(1); root.querySelector('.fc-msg').textContent = 'Progress restored.'; }
          catch (err) { msg.textContent = 'That code did not work. Copy the whole backup code and try again.'; }
          break;
        }
        case 'reset':
          if (t.dataset.armed) { store.reset(); renderHome(); openPanel(1); root.querySelector('.fc-msg').textContent = 'Review progress erased. Your settings were kept.'; }
          else { t.dataset.armed = '1'; t.textContent = 'Tap again to erase all review progress'; }
          break;
      }
    }
    function onKey(e) {
      if (!session || /input|textarea/i.test(document.activeElement.tagName)) return;
      const n = parseInt(e.key, 10);
      if (e.key === 'Escape') { exitSession(); return; }
      if (session.mode === 'browse') {
        if (e.key === 'ArrowRight') { session.i = (session.i + 1) % session.cards.length; showBrowse(); }
        else if (e.key === 'ArrowLeft') { session.i = (session.i - 1 + session.cards.length) % session.cards.length; showBrowse(); }
        else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); browseFlip(); }
        return;
      }
      if (!session.revealed) {
        if (session.current && session.current.type === 'mcq' && n >= 1 && n <= 4) {
          const oi = session.order[n - 1];
          session.mode === 'quiz' ? quizReveal(oi) : reveal(oi);
        } else if ((e.key === ' ' || e.key === 'Enter') && session.current && session.current.type !== 'mcq') { e.preventDefault(); reveal(); }
      } else if (session.mode === 'study' && n >= 1 && n <= 4 && document.querySelector(`.fc-grade[data-grade="${n}"]`)) grade(n);
      else if (session.mode === 'study' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); const b = document.querySelector('.fc-grade.fc-good') || document.querySelector('.fc-grade'); b && grade(+b.dataset.grade); }
      else if (session.mode === 'quiz' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); session.i++; showQuiz(); }
    }

    const onPop = () => { if (session) renderHome(); };
    const ovClick = e => { if (e.target.closest('.fc-session')) onClick(e); };
    window.addEventListener('popstate', onPop);
    root.addEventListener('click', onClick);
    document.addEventListener('click', ovClick);
    document.addEventListener('keydown', onKey);
    renderHome();
    return {
      destroy() {
        closeSession();
        root.removeEventListener('click', onClick);
        document.removeEventListener('click', ovClick);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('popstate', onPop);
      },
      _store: store // test hook
    };
  }

  window.Flashcards = { mountReview, schedule };
})();
