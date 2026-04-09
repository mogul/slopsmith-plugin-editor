/* Slopsmith Arrangement Editor — DAW-style timeline note editor */

(function () {
'use strict';

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

const STRING_COLORS = [
    '#FC3A51', // 0 low E — red
    '#FFC600', // 1 A     — yellow
    '#3FAAFF', // 2 D     — blue
    '#FF8A00', // 3 G     — orange
    '#58D263', // 4 B     — green
    '#C473FF', // 5 high e — purple
];
// Display: lane 0 = high e (top), lane 5 = low E (bottom)
const LANE_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];

const WAVEFORM_H = 70;
const LANE_H = 44;
const LANES = 6;
const BEAT_H = 24;
const LABEL_W = 52;
const MIN_NOTE_W = 18;
const NOTE_PAD = 3;
const SNAP_VALUES = [1, 0.5, 0.25, 0.125, 0.0625, 0]; // 1/1 … 1/16, off
const DPR = window.devicePixelRatio || 1;

// ════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════

const S = {
    // Song data
    title: '', artist: '', sessionId: null, filename: '',
    arrangements: [],
    currentArr: 0,
    beats: [], sections: [], duration: 0, offset: 0,

    // View
    scrollX: 0,   // seconds
    zoom: 120,     // px per second
    snapIdx: 2,    // default 1/4

    // Selection
    sel: new Set(),

    // Drag state
    drag: null, // { type, startX, startY, startTime, startString, noteIdx, origTimes, origStrings }

    // Playback
    playing: false,
    cursorTime: 0,
    audioCtx: null, audioBuffer: null, audioSource: null,
    playStartWall: 0, playStartTime: 0,

    // Waveform cache
    waveformPeaks: null,

    // History
    history: null,

    // Songs list cache
    songsList: null,
};

let canvas, ctx;
let rafId = null;

// ════════════════════════════════════════════════════════════════════
// Coordinate mapping
// ════════════════════════════════════════════════════════════════════

function timeToX(t)  { return LABEL_W + (t - S.scrollX) * S.zoom; }
function xToTime(x)  { return (x - LABEL_W) / S.zoom + S.scrollX; }
function laneToY(l)  { return WAVEFORM_H + l * LANE_H; }
function yToLane(y)  { return Math.floor((y - WAVEFORM_H) / LANE_H); }
function strToLane(s) { return 5 - s; }
function laneToStr(l) { return 5 - l; }
function strToY(s)   { return laneToY(strToLane(s)); }
function yToStr(y)   { const l = Math.max(0, Math.min(5, yToLane(y))); return laneToStr(l); }
function canvasH()   { return WAVEFORM_H + LANES * LANE_H + BEAT_H; }

function snapTime(t) {
    const sv = SNAP_VALUES[S.snapIdx];
    if (sv === 0 || S.beats.length < 2) return t;
    // Find surrounding beat
    let bi = 0;
    for (let i = 0; i < S.beats.length - 1; i++) {
        if (S.beats[i].time <= t) bi = i; else break;
    }
    const bt = S.beats[bi].time;
    const nt = bi < S.beats.length - 1 ? S.beats[bi + 1].time : bt + 0.5;
    const bd = nt - bt;
    const subs = 1 / sv;
    const sd = bd / subs;
    const idx = Math.round((t - bt) / sd);
    return bt + idx * sd;
}

// ════════════════════════════════════════════════════════════════════
// Note accessors
// ════════════════════════════════════════════════════════════════════

function notes() { return S.arrangements.length ? S.arrangements[S.currentArr].notes : []; }
function chords() { return S.arrangements.length ? S.arrangements[S.currentArr].chords : []; }

// ════════════════════════════════════════════════════════════════════
// Drawing
// ════════════════════════════════════════════════════════════════════

function draw() {
    if (!canvas) return;
    const w = canvas.width / DPR;
    const h = canvas.height / DPR;
    ctx.save();
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, w, h);

    drawWaveform(w);
    drawLanes(w);
    drawGrid(w);
    drawBeatBar(w);
    drawChordNotes(w);
    drawNotes(w);
    drawSelectionRect(w);
    drawCursor(w, h);
    drawLabels(w);

    ctx.restore();
}

function drawWaveform(w) {
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, w, WAVEFORM_H);
    if (!S.waveformPeaks) return;

    const peaks = S.waveformPeaks;
    const mid = WAVEFORM_H / 2;
    ctx.fillStyle = '#4080e060';
    for (let px = LABEL_W; px < w; px++) {
        const t = xToTime(px);
        if (t < 0 || t >= S.duration) continue;
        const i = Math.floor(t / S.duration * peaks.length);
        if (i < 0 || i >= peaks.length) continue;
        const bh = peaks[i] * (WAVEFORM_H / 2 - 4);
        ctx.fillRect(px, mid - bh, 1, bh * 2);
    }
}

function drawLanes(w) {
    for (let l = 0; l < LANES; l++) {
        const y = laneToY(l);
        ctx.fillStyle = l % 2 === 0 ? '#0c0c1c' : '#0f0f24';
        ctx.fillRect(LABEL_W, y, w - LABEL_W, LANE_H);
        // Separator
        ctx.strokeStyle = '#1a1a35';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_W, y + LANE_H);
        ctx.lineTo(w, y + LANE_H);
        ctx.stroke();
    }
}

function drawGrid(w) {
    const st = S.scrollX - 1;
    const et = S.scrollX + (w - LABEL_W) / S.zoom + 1;
    for (const b of S.beats) {
        if (b.time < st || b.time > et) continue;
        const x = timeToX(b.time);
        if (x < LABEL_W || x > w) continue;
        const meas = b.measure > 0;
        ctx.strokeStyle = meas ? '#2a2a50' : '#16162c';
        ctx.lineWidth = meas ? 1.5 : 0.5;
        ctx.beginPath();
        ctx.moveTo(x, WAVEFORM_H);
        ctx.lineTo(x, WAVEFORM_H + LANES * LANE_H);
        ctx.stroke();
    }
}

function drawBeatBar(w) {
    const y = WAVEFORM_H + LANES * LANE_H;
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, y, w, BEAT_H);
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, y, LABEL_W, BEAT_H);

    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const st = S.scrollX - 1;
    const et = S.scrollX + (w - LABEL_W) / S.zoom + 1;
    for (const b of S.beats) {
        if (b.measure <= 0 || b.time < st || b.time > et) continue;
        const x = timeToX(b.time);
        if (x < LABEL_W || x > w) continue;
        ctx.fillText(String(b.measure), x, y + BEAT_H / 2);
    }
}

function drawLabels(w) {
    // Waveform label
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, LABEL_W, WAVEFORM_H);
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Audio', LABEL_W / 2, WAVEFORM_H / 2);

    // String labels
    for (let l = 0; l < LANES; l++) {
        const y = laneToY(l);
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, y, LABEL_W, LANE_H);
        const s = laneToStr(l);
        ctx.fillStyle = STRING_COLORS[s];
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(LANE_LABELS[l], LABEL_W / 2, y + LANE_H / 2);
    }
}

function drawNotes(w) {
    const nn = notes();
    const st = S.scrollX - 2;
    const et = S.scrollX + (w - LABEL_W) / S.zoom + 2;
    for (let i = 0; i < nn.length; i++) {
        const n = nn[i];
        if (n.time + (n.sustain || 0) < st || n.time > et) continue;
        _drawNote(n, S.sel.has(i), 'note');
    }
}

function drawChordNotes(w) {
    const cc = chords();
    const st = S.scrollX - 2;
    const et = S.scrollX + (w - LABEL_W) / S.zoom + 2;
    for (const ch of cc) {
        if (ch.time < st || ch.time > et) continue;
        for (const cn of ch.notes) {
            _drawNote({ ...cn, time: cn.time || ch.time }, false, 'chord');
        }
    }
}

function _drawNote(n, selected, type) {
    const x = timeToX(n.time);
    const y = strToY(n.string) + NOTE_PAD;
    const sw = Math.max(MIN_NOTE_W, (n.sustain || 0) * S.zoom);
    const h = LANE_H - NOTE_PAD * 2;
    const color = STRING_COLORS[n.string] || '#888';

    // Body
    ctx.fillStyle = type === 'chord' ? color + 'aa' : color + 'cc';
    ctx.beginPath();
    ctx.roundRect(x, y, sw, h, 3);
    ctx.fill();

    // Border
    if (selected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
    } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.5;
    }
    ctx.beginPath();
    ctx.roundRect(x, y, sw, h, 3);
    ctx.stroke();

    // Fret number
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n.fret), x + Math.min(sw, MIN_NOTE_W) / 2, y + h / 2);

    // Technique badges
    const techs = n.techniques || {};
    const badges = [];
    if (techs.hammer_on) badges.push('H');
    if (techs.pull_off) badges.push('P');
    if (techs.slide_to >= 0) badges.push('/' + techs.slide_to);
    if (techs.bend > 0) badges.push('b');
    if (techs.harmonic) badges.push('*');
    if (techs.palm_mute) badges.push('PM');
    if (techs.tap) badges.push('T');
    if (techs.tremolo) badges.push('~');
    if (techs.mute) badges.push('x');
    if (badges.length) {
        ctx.fillStyle = '#ffffffbb';
        ctx.font = '7px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(badges.join(' '), x + 2, y + 9);
    }

    // Sustain tail
    if (sw > MIN_NOTE_W) {
        ctx.fillStyle = color + '40';
        ctx.fillRect(x + MIN_NOTE_W, y + h / 2 - 2, sw - MIN_NOTE_W, 4);
    }
}

function drawCursor(w, h) {
    const x = timeToX(S.cursorTime);
    if (x < LABEL_W || x > w) return;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasH());
    ctx.stroke();
}

function drawSelectionRect() {
    if (!S.drag || S.drag.type !== 'select') return;
    const x1 = Math.min(S.drag.startX, S.drag.curX);
    const y1 = Math.min(S.drag.startY, S.drag.curY);
    const x2 = Math.max(S.drag.startX, S.drag.curX);
    const y2 = Math.max(S.drag.startY, S.drag.curY);
    ctx.strokeStyle = '#4080e0';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    ctx.fillStyle = '#4080e018';
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
}

// ════════════════════════════════════════════════════════════════════
// Hit testing
// ════════════════════════════════════════════════════════════════════

function hitNote(mx, my) {
    const nn = notes();
    for (let i = nn.length - 1; i >= 0; i--) {
        const n = nn[i];
        const x = timeToX(n.time);
        const y = strToY(n.string) + NOTE_PAD;
        const w = Math.max(MIN_NOTE_W, (n.sustain || 0) * S.zoom);
        const h = LANE_H - NOTE_PAD * 2;
        if (mx >= x && mx <= x + w && my >= y && my <= y + h) return i;
    }
    return -1;
}

// ════════════════════════════════════════════════════════════════════
// Undo / Redo
// ════════════════════════════════════════════════════════════════════

class EditHistory {
    constructor() { this.undo = []; this.redo = []; }
    exec(cmd) { cmd.exec(); this.undo.push(cmd); this.redo = []; this._ui(); }
    doUndo() { if (!this.undo.length) return; const c = this.undo.pop(); c.rollback(); this.redo.push(c); this._ui(); draw(); }
    doRedo() { if (!this.redo.length) return; const c = this.redo.pop(); c.exec(); this.undo.push(c); this._ui(); draw(); }
    _ui() {
        const u = document.getElementById('editor-undo');
        const r = document.getElementById('editor-redo');
        if (u) u.disabled = !this.undo.length;
        if (r) r.disabled = !this.redo.length;
    }
}

class MoveNoteCmd {
    constructor(indices, dtimes, dstrings) {
        this.indices = indices;
        this.dtimes = dtimes;
        this.dstrings = dstrings;
    }
    exec() {
        const nn = notes();
        for (let i = 0; i < this.indices.length; i++) {
            nn[this.indices[i]].time += this.dtimes[i];
            nn[this.indices[i]].string += this.dstrings[i];
        }
    }
    rollback() {
        const nn = notes();
        for (let i = 0; i < this.indices.length; i++) {
            nn[this.indices[i]].time -= this.dtimes[i];
            nn[this.indices[i]].string -= this.dstrings[i];
        }
    }
}

class AddNoteCmd {
    constructor(note) { this.note = note; this.idx = -1; }
    exec() {
        const nn = notes();
        nn.push(this.note);
        this.idx = nn.length - 1;
        nn.sort((a, b) => a.time - b.time);
        // Find new index
        this.idx = nn.indexOf(this.note);
    }
    rollback() {
        const nn = notes();
        const i = nn.indexOf(this.note);
        if (i >= 0) nn.splice(i, 1);
    }
}

class DeleteNotesCmd {
    constructor(indices) {
        this.indices = [...indices].sort((a, b) => b - a);
        this.removed = [];
    }
    exec() {
        const nn = notes();
        this.removed = [];
        for (const i of this.indices) {
            this.removed.push({ idx: i, note: nn[i] });
            nn.splice(i, 1);
        }
        S.sel.clear();
    }
    rollback() {
        const nn = notes();
        for (const r of [...this.removed].reverse()) {
            nn.splice(r.idx, 0, r.note);
        }
    }
}

class ChangeFretCmd {
    constructor(index, newFret) {
        this.index = index;
        this.newFret = newFret;
        this.oldFret = notes()[index].fret;
    }
    exec() { notes()[this.index].fret = this.newFret; }
    rollback() { notes()[this.index].fret = this.oldFret; }
}

// ════════════════════════════════════════════════════════════════════
// Mouse interactions
// ════════════════════════════════════════════════════════════════════

function getMousePos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
    const { x, y } = getMousePos(e);
    hideContextMenu();
    hideAddNote();

    // Middle button = pan
    if (e.button === 1) {
        e.preventDefault();
        S.drag = { type: 'pan', startX: x, origScroll: S.scrollX };
        return;
    }

    // Right button = context menu (handled in onContextMenu)
    if (e.button === 2) return;

    // Left button
    const idx = hitNote(x, y);

    if (y < WAVEFORM_H) {
        // Click on waveform = set cursor
        S.cursorTime = Math.max(0, xToTime(x));
        if (S.playing) { stopPlayback(); startPlayback(); }
        draw();
        return;
    }

    if (idx >= 0) {
        // Click on note
        if (e.shiftKey) {
            // Multi-select toggle
            if (S.sel.has(idx)) S.sel.delete(idx); else S.sel.add(idx);
        } else if (!S.sel.has(idx)) {
            S.sel.clear();
            S.sel.add(idx);
        }

        // Start drag
        const nn = notes();
        const selArr = [...S.sel];
        S.drag = {
            type: 'move',
            startX: x, startY: y,
            origTimes: selArr.map(i => nn[i].time),
            origStrings: selArr.map(i => nn[i].string),
            indices: selArr,
            moved: false,
        };
        draw();
    } else {
        // Click on empty space = start selection rect or deselect
        if (!e.shiftKey) S.sel.clear();
        S.drag = {
            type: 'select',
            startX: x, startY: y,
            curX: x, curY: y,
        };
        draw();
    }
}

function onMouseMove(e) {
    if (!S.drag) return;
    const { x, y } = getMousePos(e);

    if (S.drag.type === 'pan') {
        const dx = x - S.drag.startX;
        S.scrollX = Math.max(0, S.drag.origScroll - dx / S.zoom);
        draw();
        return;
    }

    if (S.drag.type === 'select') {
        S.drag.curX = x;
        S.drag.curY = y;
        draw();
        return;
    }

    if (S.drag.type === 'move') {
        S.drag.moved = true;
        const nn = notes();
        const dt = (x - S.drag.startX) / S.zoom;
        const dy = y - S.drag.startY;
        const dLanes = Math.round(dy / LANE_H);

        for (let i = 0; i < S.drag.indices.length; i++) {
            const ni = S.drag.indices[i];
            let newTime = S.drag.origTimes[i] + dt;
            newTime = snapTime(Math.max(0, newTime));
            nn[ni].time = newTime;

            const origLane = strToLane(S.drag.origStrings[i]);
            const newLane = Math.max(0, Math.min(5, origLane + dLanes));
            nn[ni].string = laneToStr(newLane);
        }
        draw();
    }
}

function onMouseUp(e) {
    if (!S.drag) return;
    const { x, y } = getMousePos(e);

    if (S.drag.type === 'move' && S.drag.moved) {
        // Commit move as undo command
        const nn = notes();
        const dtimes = S.drag.indices.map((ni, i) => nn[ni].time - S.drag.origTimes[i]);
        const dstrings = S.drag.indices.map((ni, i) => nn[ni].string - S.drag.origStrings[i]);

        // Revert to original first so exec() applies the delta
        for (let i = 0; i < S.drag.indices.length; i++) {
            nn[S.drag.indices[i]].time = S.drag.origTimes[i];
            nn[S.drag.indices[i]].string = S.drag.origStrings[i];
        }
        S.history.exec(new MoveNoteCmd(S.drag.indices, dtimes, dstrings));
    }

    if (S.drag.type === 'select') {
        // Select notes inside rectangle
        const x1 = Math.min(S.drag.startX, S.drag.curX);
        const y1 = Math.min(S.drag.startY, S.drag.curY);
        const x2 = Math.max(S.drag.startX, S.drag.curX);
        const y2 = Math.max(S.drag.startY, S.drag.curY);

        const nn = notes();
        for (let i = 0; i < nn.length; i++) {
            const nx = timeToX(nn[i].time);
            const ny = strToY(nn[i].string) + LANE_H / 2;
            if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2) {
                S.sel.add(i);
            }
        }
    }

    S.drag = null;
    draw();
    updateStatus();
}

function onDblClick(e) {
    const { x, y } = getMousePos(e);
    if (y < WAVEFORM_H || y > WAVEFORM_H + LANES * LANE_H) return;

    const idx = hitNote(x, y);
    if (idx >= 0) return; // double-click on existing note = no-op

    // Show add-note dialog
    const t = snapTime(Math.max(0, xToTime(x)));
    const s = yToStr(y);
    showAddNote(e.clientX, e.clientY, t, s);
}

function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
        // Ctrl+scroll = zoom
        const { x } = getMousePos(e);
        const timeBefore = xToTime(x);
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        S.zoom = Math.max(20, Math.min(2000, S.zoom * factor));
        // Keep the time under cursor stable
        S.scrollX = timeBefore - (x - LABEL_W) / S.zoom;
        S.scrollX = Math.max(0, S.scrollX);
    } else {
        // Scroll = pan
        S.scrollX = Math.max(0, S.scrollX + e.deltaY / S.zoom * 2);
    }
    updateZoomDisplay();
    draw();
}

function onContextMenu(e) {
    e.preventDefault();
    const { x, y } = getMousePos(e);
    const idx = hitNote(x, y);
    if (idx < 0) return;

    if (!S.sel.has(idx)) {
        S.sel.clear();
        S.sel.add(idx);
    }
    draw();
    showContextMenu(e.clientX, e.clientY, idx);
}

function onKeyDown(e) {
    // Only handle when editor screen is visible
    const screen = document.getElementById('plugin-editor');
    if (!screen || !screen.classList.contains('active')) return;

    if (e.key === ' ' && !e.target.matches('input, select, textarea')) {
        e.preventDefault();
        editorTogglePlay();
        return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (S.sel.size && !e.target.matches('input, select, textarea')) {
            e.preventDefault();
            S.history.exec(new DeleteNotesCmd([...S.sel]));
            draw();
            updateStatus();
            return;
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        editorUndo();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        editorRedo();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        if (!e.target.matches('input, select, textarea')) {
            e.preventDefault();
            const nn = notes();
            for (let i = 0; i < nn.length; i++) S.sel.add(i);
            draw();
            return;
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Context menu
// ════════════════════════════════════════════════════════════════════

function showContextMenu(cx, cy, idx) {
    const menu = document.getElementById('editor-context-menu');
    const items = [
        { label: 'Change Fret...', action: () => promptFret(idx) },
        { label: 'Delete', action: () => { S.history.exec(new DeleteNotesCmd([...S.sel])); draw(); updateStatus(); } },
        { type: 'sep' },
        { label: 'Hammer-On', toggle: 'hammer_on', idx },
        { label: 'Pull-Off', toggle: 'pull_off', idx },
        { label: 'Palm Mute', toggle: 'palm_mute', idx },
        { label: 'Harmonic', toggle: 'harmonic', idx },
        { label: 'Accent', toggle: 'accent', idx },
        { label: 'Tap', toggle: 'tap', idx },
        { label: 'Tremolo', toggle: 'tremolo', idx },
        { label: 'Mute', toggle: 'mute', idx },
    ];

    const n = notes()[idx];
    let html = '';
    for (const it of items) {
        if (it.type === 'sep') {
            html += '<div class="border-t border-gray-700 my-1"></div>';
            continue;
        }
        if (it.toggle) {
            const techs = n.techniques || {};
            const on = techs[it.toggle];
            html += `<button class="w-full text-left px-3 py-1 text-xs hover:bg-dark-500 flex items-center gap-2" onclick="editorToggleTech(${idx},'${it.toggle}')">
                <span class="w-3">${on ? '✓' : ''}</span>${it.label}</button>`;
        } else {
            html += `<button class="w-full text-left px-3 py-1 text-xs hover:bg-dark-500" data-action="${items.indexOf(it)}">${it.label}</button>`;
        }
    }
    menu.innerHTML = html;
    // Wire up non-toggle actions
    menu.querySelectorAll('[data-action]').forEach(btn => {
        const actionItem = items[parseInt(btn.dataset.action)];
        btn.onclick = () => { hideContextMenu(); actionItem.action(); };
    });

    menu.style.left = cx + 'px';
    menu.style.top = cy + 'px';
    menu.classList.remove('hidden');
}

function hideContextMenu() {
    document.getElementById('editor-context-menu').classList.add('hidden');
}

function promptFret(idx) {
    hideContextMenu();
    const current = notes()[idx].fret;
    const val = prompt('Fret number (0-24):', current);
    if (val === null) return;
    const fret = Math.max(0, Math.min(24, parseInt(val) || 0));
    S.history.exec(new ChangeFretCmd(idx, fret));
    draw();
}

// ════════════════════════════════════════════════════════════════════
// Add note dialog
// ════════════════════════════════════════════════════════════════════

let addNoteData = null;

function showAddNote(cx, cy, time, string) {
    addNoteData = { time, string };
    const dlg = document.getElementById('editor-add-note-dialog');
    dlg.style.left = cx + 'px';
    dlg.style.top = cy + 'px';
    dlg.classList.remove('hidden');
    const inp = document.getElementById('editor-add-fret');
    inp.value = '0';
    inp.focus();
    inp.select();
}

function hideAddNote() {
    document.getElementById('editor-add-note-dialog').classList.add('hidden');
    addNoteData = null;
}

window.editorConfirmAddNote = function() {
    if (!addNoteData) return;
    const fret = Math.max(0, Math.min(24, parseInt(document.getElementById('editor-add-fret').value) || 0));
    const sustain = Math.max(0, parseFloat(document.getElementById('editor-add-sustain').value) || 0);
    const note = {
        time: addNoteData.time,
        string: addNoteData.string,
        fret,
        sustain,
        techniques: {},
    };
    S.history.exec(new AddNoteCmd(note));
    hideAddNote();
    draw();
    updateStatus();
};

window.editorHideAddNote = hideAddNote;

// Handle Enter key in add-note dialog
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && addNoteData) {
        e.preventDefault();
        editorConfirmAddNote();
    }
    if (e.key === 'Escape') {
        hideAddNote();
        hideContextMenu();
        editorHideLoadModal();
    }
});

// ════════════════════════════════════════════════════════════════════
// Audio / Playback
// ════════════════════════════════════════════════════════════════════

async function loadAudio(url) {
    if (!url) return;
    try {
        if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        S.audioBuffer = await S.audioCtx.decodeAudioData(buf);
        S.duration = S.audioBuffer.duration;
        computeWaveform();
    } catch (e) {
        console.error('Audio load error:', e);
    }
}

function computeWaveform() {
    if (!S.audioBuffer) return;
    const data = S.audioBuffer.getChannelData(0);
    const buckets = 4000;
    const peaks = new Float32Array(buckets);
    const samplesPerBucket = Math.floor(data.length / buckets);
    for (let b = 0; b < buckets; b++) {
        let max = 0;
        const start = b * samplesPerBucket;
        for (let s = 0; s < samplesPerBucket; s++) {
            const v = Math.abs(data[start + s]);
            if (v > max) max = v;
        }
        peaks[b] = max;
    }
    S.waveformPeaks = peaks;
}

function startPlayback() {
    if (!S.audioBuffer || !S.audioCtx) return;
    if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
    S.audioSource = S.audioCtx.createBufferSource();
    S.audioSource.buffer = S.audioBuffer;
    S.audioSource.connect(S.audioCtx.destination);
    S.audioSource.start(0, S.cursorTime);
    S.playStartWall = S.audioCtx.currentTime;
    S.playStartTime = S.cursorTime;
    S.playing = true;
    updatePlayIcon();
    playbackTick();
}

function stopPlayback() {
    if (S.audioSource) {
        try { S.audioSource.stop(); } catch (_) {}
        S.audioSource = null;
    }
    S.playing = false;
    updatePlayIcon();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function playbackTick() {
    if (!S.playing) return;
    S.cursorTime = S.playStartTime + (S.audioCtx.currentTime - S.playStartWall);
    if (S.cursorTime >= S.duration) {
        stopPlayback();
        S.cursorTime = 0;
    }

    // Auto-scroll to follow cursor
    const cx = timeToX(S.cursorTime);
    const w = canvas ? canvas.width / DPR : 800;
    if (cx > w * 0.8) {
        S.scrollX = S.cursorTime - (w * 0.3) / S.zoom;
    }

    updateTimeDisplay();
    draw();
    rafId = requestAnimationFrame(playbackTick);
}

function updatePlayIcon() {
    const icon = document.getElementById('editor-play-icon');
    if (!icon) return;
    if (S.playing) {
        icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
}

function updateTimeDisplay() {
    const el = document.getElementById('editor-time-display');
    if (!el) return;
    const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return m + ':' + String(s).padStart(2, '0');
    };
    el.textContent = fmt(S.cursorTime) + ' / ' + fmt(S.duration);
}

// ════════════════════════════════════════════════════════════════════
// File operations
// ════════════════════════════════════════════════════════════════════

async function loadCDLC(filename) {
    setStatus('Loading ' + filename + '...');
    try {
        const resp = await fetch('/api/plugins/editor/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        const data = await resp.json();
        if (data.error) { setStatus('Error: ' + data.error); return; }

        S.title = data.title || '';
        S.artist = data.artist || '';
        S.filename = filename;
        S.sessionId = data.session_id;
        S.arrangements = data.arrangements || [];
        S.beats = data.beats || [];
        S.sections = data.sections || [];
        S.duration = data.duration || 0;
        S.offset = data.offset || 0;
        S.currentArr = 0;
        S.sel.clear();
        S.scrollX = 0;
        S.cursorTime = 0;
        S.history = new EditHistory();

        // Update UI
        document.getElementById('editor-song-title').textContent =
            `${S.artist} — ${S.title}`;
        document.getElementById('editor-save-btn').disabled = false;
        document.getElementById('editor-play-btn').disabled = !data.audio_url;
        updateArrangementSelector();
        updateStatus();
        updateTimeDisplay();

        // Load audio
        if (data.audio_url) {
            await loadAudio(data.audio_url);
        }

        draw();
        setStatus('Loaded: ' + S.artist + ' — ' + S.title);
    } catch (e) {
        setStatus('Load failed: ' + e.message);
    }
}

function updateArrangementSelector() {
    const sel = document.getElementById('editor-arrangement');
    sel.innerHTML = '';
    S.arrangements.forEach((arr, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = arr.name;
        sel.appendChild(opt);
    });
    sel.style.display = S.arrangements.length > 1 ? '' : 'none';
}

// ════════════════════════════════════════════════════════════════════
// Load modal
// ════════════════════════════════════════════════════════════════════

async function showLoadModal() {
    const modal = document.getElementById('editor-load-modal');
    modal.classList.remove('hidden');
    document.getElementById('editor-load-search').value = '';

    if (!S.songsList) {
        try {
            S.songsList = await fetch('/api/plugins/editor/songs').then(r => r.json());
        } catch {
            S.songsList = [];
        }
    }
    renderSongList(S.songsList);
    document.getElementById('editor-load-search').focus();
}

function renderSongList(files) {
    const list = document.getElementById('editor-load-list');
    if (!files.length) {
        list.innerHTML = '<div class="text-xs text-gray-500 p-2">No CDLC files found</div>';
        return;
    }
    list.innerHTML = files.map(f =>
        `<button onclick="editorLoadFile('${f.replace(/'/g, "\\'")}')" class="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-dark-500 rounded truncate">${f}</button>`
    ).join('');
}

function filterSongs(q) {
    if (!S.songsList) return;
    const low = q.toLowerCase();
    const filtered = S.songsList.filter(f => f.toLowerCase().includes(low));
    renderSongList(filtered);
}

// ════════════════════════════════════════════════════════════════════
// Save
// ════════════════════════════════════════════════════════════════════

async function saveCDLC() {
    if (!S.sessionId) return;
    setStatus('Saving...');
    const arr = S.arrangements[S.currentArr];
    try {
        const resp = await fetch('/api/plugins/editor/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: S.sessionId,
                arrangement_index: S.currentArr,
                notes: arr.notes,
                chords: arr.chords,
                chord_templates: arr.chord_templates,
                beats: S.beats,
                sections: S.sections,
            }),
        });
        const data = await resp.json();
        if (data.error) { setStatus('Save error: ' + data.error); return; }
        setStatus('Saved successfully');
    } catch (e) {
        setStatus('Save failed: ' + e.message);
    }
}

// ════════════════════════════════════════════════════════════════════
// UI Helpers
// ════════════════════════════════════════════════════════════════════

function setStatus(msg) {
    const el = document.getElementById('editor-status');
    if (el) el.textContent = msg;
}

function updateStatus() {
    const nn = notes();
    const cc = chords();
    document.getElementById('editor-note-count').textContent =
        `${nn.length} notes, ${cc.length} chords` + (S.sel.size ? ` | ${S.sel.size} selected` : '');
    setStatus('Ready');
}

function updateZoomDisplay() {
    const el = document.getElementById('editor-zoom-display');
    if (el) el.textContent = Math.round(S.zoom);
}

function resizeCanvas() {
    if (!canvas) return;
    const wrap = document.getElementById('editor-canvas-wrap');
    const w = wrap.clientWidth;
    const h = canvasH();
    canvas.width = w * DPR;
    canvas.height = h * DPR;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    draw();
}

// ════════════════════════════════════════════════════════════════════
// Global API (called from HTML)
// ════════════════════════════════════════════════════════════════════

window.editorShowLoadModal = showLoadModal;
window.editorHideLoadModal = () => document.getElementById('editor-load-modal').classList.add('hidden');
window.editorFilterSongs = filterSongs;
window.editorLoadFile = (f) => { editorHideLoadModal(); loadCDLC(f); };
window.editorSave = saveCDLC;
window.editorUndo = () => S.history && S.history.doUndo();
window.editorRedo = () => S.history && S.history.doRedo();
window.editorTogglePlay = () => {
    if (S.playing) stopPlayback(); else startPlayback();
};
window.editorZoom = (dir) => {
    const factor = dir > 0 ? 1.3 : 0.77;
    S.zoom = Math.max(20, Math.min(2000, S.zoom * factor));
    updateZoomDisplay();
    draw();
};
window.editorSetSnap = (idx) => { S.snapIdx = idx; };
window.editorSelectArrangement = (val) => {
    S.currentArr = parseInt(val) || 0;
    S.sel.clear();
    draw();
    updateStatus();
};
window.editorToggleTech = (idx, tech) => {
    const n = notes()[idx];
    if (!n.techniques) n.techniques = {};
    n.techniques[tech] = !n.techniques[tech];
    hideContextMenu();
    draw();
};

// Allow loading from other plugins/screens
window.editSong = (filename) => {
    showScreen('plugin-editor');
    loadCDLC(filename);
};

// ════════════════════════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════════════════════════

function init() {
    canvas = document.getElementById('editor-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    S.history = new EditHistory();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);

    // Prevent middle-click paste
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Observe screen visibility for resize
    const obs = new MutationObserver(() => {
        const screen = document.getElementById('plugin-editor');
        if (screen && screen.classList.contains('active')) {
            setTimeout(resizeCanvas, 50);
        }
    });
    const screen = document.getElementById('plugin-editor');
    if (screen) obs.observe(screen, { attributes: true, attributeFilter: ['class'] });

    draw();
}

// Run init after DOM is ready
if (document.getElementById('editor-canvas')) {
    init();
} else {
    // Wait for plugin screen to be injected
    const check = setInterval(() => {
        if (document.getElementById('editor-canvas')) {
            clearInterval(check);
            init();
        }
    }, 100);
}

})();
