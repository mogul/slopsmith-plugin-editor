"""Arrangement Editor plugin — backend routes."""

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.dom import minidom

from fastapi import UploadFile, File
from fastapi.responses import FileResponse, JSONResponse


def setup(app, context):
    config_dir = context["config_dir"]
    get_dlc_dir = context["get_dlc_dir"]

    from lib.song import load_song
    from lib.psarc import unpack_psarc
    from lib.patcher import pack_psarc
    from lib.audio import find_wem_files, convert_wem

    STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"

    # Active editing sessions: session_id -> {dir, audio_file, filename, song_data}
    sessions = {}

    # ── List available CDLC files ────────────────────────────────────────

    @app.get("/api/plugins/editor/songs")
    async def list_songs():
        dlc_dir = get_dlc_dir()
        if not dlc_dir or not dlc_dir.exists():
            return []
        files = sorted(
            f.name for f in dlc_dir.iterdir()
            if f.suffix == ".psarc" and f.is_file()
        )
        return files

    # ── Load a CDLC for editing ──────────────────────────────────────────

    @app.post("/api/plugins/editor/load")
    async def load_cdlc(data: dict):
        filename = data.get("filename", "")
        if not filename:
            return JSONResponse({"error": "No filename"}, 400)

        dlc_dir = get_dlc_dir()
        filepath = dlc_dir / filename
        if not filepath.exists():
            return JSONResponse({"error": "File not found"}, 404)

        def _load():
            tmp_dir = tempfile.mkdtemp(prefix="slopsmith_editor_")
            try:
                unpack_psarc(str(filepath), tmp_dir)
                song = load_song(tmp_dir)
            except Exception as e:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                raise RuntimeError(f"Failed to load: {e}")

            # Convert audio
            audio_url = None
            audio_file = None
            wem_files = find_wem_files(tmp_dir)
            if wem_files:
                try:
                    audio_path = convert_wem(
                        wem_files[0], os.path.join(tmp_dir, "audio")
                    )
                    audio_file = audio_path
                    audio_id = Path(filename).stem.replace(" ", "_")
                    ext = Path(audio_path).suffix
                    dest = STATIC_DIR / f"editor_audio_{audio_id}{ext}"
                    shutil.copy2(audio_path, dest)
                    audio_url = f"/static/editor_audio_{audio_id}{ext}"
                except Exception as e:
                    print(f"[Editor] Audio conversion failed: {e}")

            # Find the arrangement XML files for later save
            xml_files = []
            for xf in Path(tmp_dir).rglob("*.xml"):
                try:
                    root = ET.parse(xf).getroot()
                    if root.tag == "song":
                        el = root.find("arrangement")
                        if el is not None and el.text:
                            low = el.text.lower().strip()
                            if low not in ("vocals", "showlights", "jvocals"):
                                xml_files.append(str(xf))
                except Exception:
                    continue

            result = _song_to_dict(song, audio_url)
            return result, tmp_dir, audio_file, xml_files

        try:
            result, session_dir, audio_file, xml_files = (
                await asyncio.get_event_loop().run_in_executor(None, _load)
            )
        except Exception as e:
            return JSONResponse({"error": str(e)}, 500)

        session_id = Path(filename).stem
        # Clean up previous session for same file
        if session_id in sessions:
            old = sessions[session_id]
            shutil.rmtree(old["dir"], ignore_errors=True)

        sessions[session_id] = {
            "dir": session_dir,
            "audio_file": audio_file,
            "filename": filename,
            "xml_files": xml_files,
        }
        result["session_id"] = session_id
        return result

    # ── Save edited arrangement back to PSARC ────────────────────────────

    @app.post("/api/plugins/editor/save")
    async def save_cdlc(data: dict):
        session_id = data.get("session_id", "")
        session = sessions.get(session_id)
        if not session:
            return JSONResponse({"error": "No active session"}, 400)

        arrangement_index = data.get("arrangement_index", 0)
        notes = data.get("notes", [])
        chords = data.get("chords", [])
        chord_templates = data.get("chord_templates", [])
        beats = data.get("beats", [])
        sections = data.get("sections", [])
        metadata = data.get("metadata", {})

        def _save():
            xml_files = session["xml_files"]
            if arrangement_index >= len(xml_files):
                raise RuntimeError("Invalid arrangement index")

            xml_path = xml_files[arrangement_index]

            # Read existing XML for metadata we want to preserve
            tree = ET.parse(xml_path)
            old_root = tree.getroot()

            # Build new XML
            xml_str = _build_arrangement_xml(
                old_root, notes, chords, chord_templates, beats, sections, metadata
            )

            # Write XML
            Path(xml_path).write_text(xml_str)

            # Try to compile XML -> SNG
            _compile_sng(xml_path)

            # Pack back to PSARC
            dlc_dir = get_dlc_dir()
            filename = session["filename"]
            output_path = dlc_dir / filename

            # Backup original
            backup = dlc_dir / (filename + ".bak")
            if output_path.exists() and not backup.exists():
                shutil.copy2(output_path, backup)

            pack_psarc(session["dir"], str(output_path))
            return str(output_path)

        try:
            output = await asyncio.get_event_loop().run_in_executor(None, _save)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, 500)

        return {"success": True, "path": output}

    # ── Upload audio (for create mode) ───────────────────────────────────

    @app.post("/api/plugins/editor/upload-audio")
    async def upload_audio(file: UploadFile = File(...)):
        audio_id = Path(file.filename).stem.replace(" ", "_")
        ext = Path(file.filename).suffix or ".mp3"
        dest = STATIC_DIR / f"editor_audio_{audio_id}{ext}"
        content = await file.read()
        dest.write_bytes(content)
        return {"audio_url": f"/static/editor_audio_{audio_id}{ext}"}

    # ── Helpers ──────────────────────────────────────────────────────────

    def _song_to_dict(song, audio_url):
        """Convert a Song object to JSON-serializable dict."""
        result = {
            "title": song.title,
            "artist": song.artist,
            "album": song.album,
            "year": song.year,
            "duration": song.song_length,
            "offset": song.offset,
            "audio_url": audio_url,
            "beats": [
                {"time": b.time, "measure": b.measure} for b in song.beats
            ],
            "sections": [
                {
                    "name": s.name,
                    "number": s.number,
                    "start_time": s.start_time,
                }
                for s in song.sections
            ],
            "arrangements": [],
        }

        for arr in song.arrangements:
            arr_data = {
                "name": arr.name,
                "tuning": arr.tuning,
                "capo": arr.capo,
                "notes": [],
                "chords": [],
                "chord_templates": [],
            }

            for n in arr.notes:
                arr_data["notes"].append({
                    "time": round(n.time, 3),
                    "string": n.string,
                    "fret": n.fret,
                    "sustain": round(n.sustain, 3),
                    "techniques": {
                        "bend": n.bend,
                        "slide_to": n.slide_to,
                        "slide_unpitch_to": n.slide_unpitch_to,
                        "hammer_on": n.hammer_on,
                        "pull_off": n.pull_off,
                        "harmonic": n.harmonic,
                        "harmonic_pinch": n.harmonic_pinch,
                        "palm_mute": n.palm_mute,
                        "mute": n.mute,
                        "tremolo": n.tremolo,
                        "accent": n.accent,
                        "tap": n.tap,
                        "link_next": n.link_next,
                    },
                })

            for ch in arr.chords:
                chord_data = {
                    "time": round(ch.time, 3),
                    "chord_id": ch.chord_id,
                    "high_density": ch.high_density,
                    "notes": [],
                }
                for cn in ch.notes:
                    chord_data["notes"].append({
                        "time": round(cn.time, 3),
                        "string": cn.string,
                        "fret": cn.fret,
                        "sustain": round(cn.sustain, 3),
                        "techniques": {
                            "bend": cn.bend,
                            "slide_to": cn.slide_to,
                            "slide_unpitch_to": cn.slide_unpitch_to,
                            "hammer_on": cn.hammer_on,
                            "pull_off": cn.pull_off,
                            "harmonic": cn.harmonic,
                            "palm_mute": cn.palm_mute,
                            "mute": cn.mute,
                            "tremolo": cn.tremolo,
                            "accent": cn.accent,
                            "tap": cn.tap,
                            "link_next": cn.link_next,
                        },
                    })
                arr_data["chords"].append(chord_data)

            for ct in arr.chord_templates:
                arr_data["chord_templates"].append({
                    "name": ct.name,
                    "frets": ct.frets,
                    "fingers": ct.fingers,
                })

            result["arrangements"].append(arr_data)

        return result

    def _build_arrangement_xml(
        old_root, notes, chords, chord_templates, beats, sections, metadata
    ):
        """Build a Rocksmith arrangement XML from editor data."""
        root = ET.Element("song", version="7")

        # Preserve metadata from original XML, override with editor metadata
        def _text(tag, fallback=""):
            el = old_root.find(tag)
            return metadata.get(tag, el.text if el is not None and el.text else fallback)

        ET.SubElement(root, "title").text = _text("title", "Untitled")
        ET.SubElement(root, "arrangement").text = _text("arrangement", "Lead")
        ET.SubElement(root, "offset").text = _text("offset", "0.000")
        ET.SubElement(root, "songLength").text = _text("songLength", "0.000")
        ET.SubElement(root, "startBeat").text = _text("startBeat", "0.000")
        ET.SubElement(root, "averageTempo").text = _text("averageTempo", "120")
        ET.SubElement(root, "artistName").text = _text("artistName", "Unknown")
        ET.SubElement(root, "albumName").text = _text("albumName", "")
        ET.SubElement(root, "albumYear").text = _text("albumYear", "")

        # Tuning — preserve from original
        old_tuning = old_root.find("tuning")
        tuning_el = ET.SubElement(root, "tuning")
        for i in range(6):
            val = "0"
            if old_tuning is not None:
                val = old_tuning.get(f"string{i}", "0")
            tuning_el.set(f"string{i}", val)

        old_capo = old_root.find("capo")
        ET.SubElement(root, "capo").text = (
            old_capo.text if old_capo is not None and old_capo.text else "0"
        )

        # Ebeats
        ebeats_el = ET.SubElement(root, "ebeats", count=str(len(beats)))
        for b in beats:
            ET.SubElement(
                ebeats_el, "ebeat",
                time=f"{b['time']:.3f}", measure=str(b["measure"]),
            )

        # Sections
        if not sections:
            sections = [{"name": "default", "number": 1, "start_time": 0.0}]
        sections_el = ET.SubElement(root, "sections", count=str(len(sections)))
        for s in sections:
            ET.SubElement(
                sections_el, "section",
                name=s["name"], number=str(s["number"]),
                startTime=f"{s['start_time']:.3f}",
            )

        # Phrases — one per section
        phrases_el = ET.SubElement(root, "phrases", count=str(len(sections)))
        for s in sections:
            ET.SubElement(
                phrases_el, "phrase",
                disparity="0", ignore="0", maxDifficulty="0",
                name=s["name"], solo="0",
            )

        phrase_iters = ET.SubElement(
            root, "phraseIterations", count=str(len(sections))
        )
        for i, s in enumerate(sections):
            ET.SubElement(
                phrase_iters, "phraseIteration",
                time=f"{s['start_time']:.3f}", phraseId=str(i),
            )

        # Chord templates
        ct_el = ET.SubElement(
            root, "chordTemplates", count=str(len(chord_templates))
        )
        for ct in chord_templates:
            attrs = {"chordName": ct.get("name", "")}
            frets = ct.get("frets", [-1] * 6)
            fingers = ct.get("fingers", [-1] * 6)
            for i in range(6):
                attrs[f"fret{i}"] = str(frets[i] if i < len(frets) else -1)
                attrs[f"finger{i}"] = str(fingers[i] if i < len(fingers) else -1)
            ET.SubElement(ct_el, "chordTemplate", **attrs)

        # Single difficulty level
        levels_el = ET.SubElement(root, "levels", count="1")
        level = ET.SubElement(levels_el, "level", difficulty="0")

        # Notes
        notes_el = ET.SubElement(level, "notes", count=str(len(notes)))
        for n in notes:
            techs = n.get("techniques", {})
            attrs = {
                "time": f"{n['time']:.3f}",
                "string": str(n["string"]),
                "fret": str(n["fret"]),
                "sustain": f"{n.get('sustain', 0.0):.3f}",
                "bend": f"{techs.get('bend', 0.0):.1f}",
                "hammerOn": "1" if techs.get("hammer_on") else "0",
                "pullOff": "1" if techs.get("pull_off") else "0",
                "slideTo": str(techs.get("slide_to", -1)),
                "slideUnpitchTo": str(techs.get("slide_unpitch_to", -1)),
                "harmonic": "1" if techs.get("harmonic") else "0",
                "harmonicPinch": "1" if techs.get("harmonic_pinch") else "0",
                "palmMute": "1" if techs.get("palm_mute") else "0",
                "mute": "1" if techs.get("mute") else "0",
                "tremolo": "1" if techs.get("tremolo") else "0",
                "accent": "1" if techs.get("accent") else "0",
                "linkNext": "1" if techs.get("link_next") else "0",
                "tap": "1" if techs.get("tap") else "0",
                "ignore": "0",
            }
            ET.SubElement(notes_el, "note", **attrs)

        # Chords
        chords_el = ET.SubElement(level, "chords", count=str(len(chords)))
        for ch in chords:
            chord_el = ET.SubElement(
                chords_el, "chord",
                time=f"{ch['time']:.3f}",
                chordId=str(ch.get("chord_id", 0)),
                highDensity="1" if ch.get("high_density") else "0",
                strum="down",
            )
            for cn in ch.get("notes", []):
                techs = cn.get("techniques", {})
                ET.SubElement(
                    chord_el, "chordNote",
                    time=f"{cn['time']:.3f}",
                    string=str(cn["string"]),
                    fret=str(cn["fret"]),
                    sustain=f"{cn.get('sustain', 0.0):.3f}",
                    bend=f"{techs.get('bend', 0.0):.1f}",
                    hammerOn="1" if techs.get("hammer_on") else "0",
                    pullOff="1" if techs.get("pull_off") else "0",
                    slideTo=str(techs.get("slide_to", -1)),
                    slideUnpitchTo=str(techs.get("slide_unpitch_to", -1)),
                    harmonic="1" if techs.get("harmonic") else "0",
                    harmonicPinch="1" if techs.get("harmonic_pinch") else "0",
                    palmMute="1" if techs.get("palm_mute") else "0",
                    mute="1" if techs.get("mute") else "0",
                    tremolo="1" if techs.get("tremolo") else "0",
                    accent="1" if techs.get("accent") else "0",
                    linkNext="1" if techs.get("link_next") else "0",
                    tap="1" if techs.get("tap") else "0",
                    ignore="0",
                )

        # Auto-generate anchors from note positions
        anchors = _compute_anchors(notes, chords)
        anchors_el = ET.SubElement(level, "anchors", count=str(len(anchors)))
        for a in anchors:
            ET.SubElement(
                anchors_el, "anchor",
                time=f"{a['time']:.3f}",
                fret=str(a["fret"]),
                width=str(a.get("width", 4)),
            )

        ET.SubElement(level, "handShapes", count="0")

        # Pretty print
        xml_str = ET.tostring(root, encoding="unicode")
        dom = minidom.parseString(xml_str)
        return dom.toprettyxml(indent="  ", encoding=None)

    def _compute_anchors(notes, chords):
        """Auto-generate anchors from note fret positions."""
        all_fretted = []
        for n in notes:
            if n["fret"] > 0:
                all_fretted.append((n["time"], n["fret"]))
        for ch in chords:
            for cn in ch.get("notes", []):
                if cn["fret"] > 0:
                    all_fretted.append((cn["time"], cn["fret"]))

        all_fretted.sort(key=lambda x: x[0])

        if not all_fretted:
            return [{"time": 0.0, "fret": 1, "width": 4}]

        anchors = [{
            "time": 0.0,
            "fret": max(1, all_fretted[0][1] - 1),
            "width": 4,
        }]

        for t, fret in all_fretted:
            a = anchors[-1]
            if fret < a["fret"] or fret > a["fret"] + a["width"]:
                new_fret = max(1, fret - 1)
                if new_fret != a["fret"]:
                    anchors.append({"time": t, "fret": new_fret, "width": 4})

        return anchors

    def _compile_sng(xml_path):
        """Try to compile XML to SNG via RsCli."""
        xml_p = Path(xml_path)
        sng_dir = xml_p.parent.parent / "bin" / "generic"
        sng_path = sng_dir / (xml_p.stem + ".sng")

        if not sng_path.exists():
            # No existing SNG to replace — CDLC may use XML directly
            return

        rscli = os.environ.get("RSCLI_PATH", "")
        if not rscli or not Path(rscli).exists():
            for p in ["/opt/rscli/RsCli", "./rscli/RsCli"]:
                if Path(p).exists():
                    rscli = p
                    break

        if not rscli:
            print("[Editor] RsCli not found, skipping SNG compilation")
            return

        try:
            result = subprocess.run(
                [rscli, "xml2sng", str(xml_path), str(sng_path), "pc"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                print(f"[Editor] xml2sng failed: {result.stderr}")
        except Exception as e:
            print(f"[Editor] xml2sng error: {e}")
