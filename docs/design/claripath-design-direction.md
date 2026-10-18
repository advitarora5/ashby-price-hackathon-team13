# Claripath design direction

Claripath ("Illuminate what matters.", *Clinical Review Intelligence*) is the new name for the SecondLook research app. This note explains how the UI redesign was decided. It is a **research tool**: nothing here implies clinical validation or real patient sign-out.

## 1. References examined

| Reference | What makes it effective | What we take |
|---|---|---|
| **PathAI AISight Dx** (pathai.com) | A filterable worklist with workload charts. Search and filter settings persist across pages and sessions. The viewer is customisable per pathologist. | The worklist is the home base, and filters and state persist across navigation. |
| **Proscia Concentriq Clinical** (proscia.com) | "Pathology shouldn't start with a sort." Worklists are configurable starting points. AI results sit *in the slide* as granular overlays the pathologist verifies. Next/previous tissue is one keypress. Reporting sits beside reading. There is a full audit log. | AI lives in the viewer and its side panel, never in a separate window. Overlays are granular and individually toggleable. The decision area is docked next to the image. |
| **Sectra Digital Pathology** (medical.sectra.com) | Worklist, viewer and reporting share one application and one interface, with AI delivered inside the same workspace. | One shell with consistent navigation, with no mode switches between "apps". |
| **NN/g Progressive Disclosure** | Show the few things most people need. Put the rest behind clearly labelled controls. Use at most two levels, and don't split tasks that depend on each other. | Overview first, then the queue, then the case. In the review side panel, tabs (Evidence, Unseen areas, Model comparison, Review decision) replace a long stack of panels. |
| **WCAG 2.2 AA** | 1.4.3 text contrast 4.5:1. 1.4.11 non-text contrast 3:1. 2.4.7 focus visible, plus 2.4.11 focus not obscured. 2.5.8 targets at least 24×24 px. 1.4.1 colour is never the only signal. Everything works by keyboard. | Tokens are contrast-checked (below). Every status pairs an icon with text. The focus ring is 2px with an offset. Controls are at least 28px tall. |
| **Automation-bias literature** (Dratsch et al., *Radiology* 2023, mammography; Rosbach et al. 2024, pathology, about 7% of correct answers flipped by wrong AI advice) | Wrong AI advice pulls readers at every experience level. Mitigations: keep the reader accountable, show the system's uncertainty and reasoning, and record an independent read first. | We keep **blind-first** (the human records an assessment before seeing AI). AI output is worded as *evidence*, not a verdict. Scores are labelled as relative and uncalibrated where they are. |

## 2. Principles adopted
1. **The tissue is the primary object.** In Slide Review the viewer takes most of the screen. Panels collapse, and overlay controls never sit on top of tissue.
2. **AI is evidence, not truth.** The wording says "flagged for inspection" and "models disagree". Scores carry their definitions: disagreement and uncertainty are *relative 0–1 ranks*, not probabilities.
3. **One primary action per screen.** On the Overview it is "Resume review" or "Open next priority case". In review it is the next step of the workflow.
4. **Calm warnings.** Amber and red appear only for meaningful states, such as unviewed high-risk tissue with thresholds from `thresholds.json`, always with text and an icon, and never animated.
5. **Honest metrics.** The Overview counts only what `/api/cases`, `/api/health`, `/api/audit` and `/api/eval/*` return. Anything else shows as "Not available".
6. **Research is separated.** A persistent quiet "Research use only" marker shows on every page. Evaluation results show their dataset, sample size and caveats, and different organs or tasks are never merged into one score.

## 3. Mistakes avoided
Hero banners and greetings. Gradients and neon "AI" styling. Robot or DNA iconography. Nested cards. Colour-only chips. Pulsing alerts (the old UI pulsed the unseen boxes; removed). "Critical missed tumour" language. Presenting the experimental disagreement score as clinical urgency. Fabricated KPIs.

## 4. Visual direction
**Palette** (contrast measured against white `#FFFFFF` / app background `#F6F8FA`):

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--c-text` | `#20364A` | primary text | 12.4 / 11.7 |
| `--c-text-2` | `#5B6B7C` | secondary text (darkened from #607285) | 5.5 / 5.1 |
| `--c-primary` | `#416B8D` | interaction, links, focus | 5.7 / 5.3; white on it 5.7 |
| `--c-primary-strong` | `#355A79` | primary hover, active nav text | 7.3 |
| `--c-teal-ink` | `#1F6B68` | "completed" text on teal tint `#E8F3F2` | 5.5 |
| `--c-amber` / `--c-amber-ink` | `#B67622` / `#8A5A14` | amber icons and borders only (3.8:1, meets the 3:1 non-text minimum, fails as text) / amber *text* on tint `#FBF3E6` | 5.3 |
| `--c-red` / `--c-red-ink` | `#B54D4D` / `#9A3B3B` | red icons and borders / red text on tint `#FAEDED` | 5.1 / 6.0 |
| `--c-green-ink` | `#2F6B47` | "all clear" text on `#EAF4EE` | 5.6 |
| `--c-border` / `--c-border-control` | `#E1E7EC` / `#7D8D9D` | dividers / input and checkbox outlines | – / 3.4 (meets 3:1) |

**Type**: Inter Variable (self-hosted via `@fontsource-variable/inter`, so no external font call in a hospital network). Scale 12 / 12.5 / 13.5 (body) / 14 / 16 / 20 / 24; nothing below 12px. Tabular numerals on every metric and table. Slide IDs in a monospace face.
**Spacing**: a 4px base (4, 8, 12, 16, 20, 24, 32). **Radii**: 4 (controls), 6 (panels), 999 (badges). **Shadows**: only on popovers and the floating viewer controls. **Motion**: 120–180ms ease-out, disabled under `prefers-reduced-motion`. **Icons**: Lucide, 16px, always paired with a text label.
**Mark**: an optical aperture. A circle holds a thin focus ring and an offset bright "lit region", suggesting a microscope field of view with one illuminated area. It is drawn in primary blue and teal.

## 5. Key pathologist journeys
1. **Start of session**: Overview, then "Resume review" (most recent in-review case from the audit log) or "Open next priority case" (highest routing-signal case not yet started).
2. **Review a case**: open the case and see the slide. On a slow-path or blind-first case, record an initial assessment, after which AI evidence is revealed. Then inspect the flagged regions, run the sign-out check and see the unseen-region alerts. Then confirm or revise, and get the second-reader recommendation.
3. **Triage the worklist**: on Cases, filter to "Needs attention" (open slow-path cases), sort by uncertainty, and open one.
4. **Audit the evidence base**: on Research Insights, review evidence quality, disagreement routing, unseen-tissue alerts and reader policy, each with its dataset and sample size.
5. **Teach or check with replay**: in Slide Review, replay a recorded PathoGaze read through the live coverage engine.

## 6. Information architecture
- **Overview** (default, `#/overview`): workload metrics, priority review queue, research summary.
- **Cases** (`#/cases`): the full worklist with search, filter and sort, split into needs attention / in review / not started / completed.
- **Slide Review** (`#/review/<case_id>`): the workspace. It stays mounted when you navigate away, so the read, viewport and evidence state are preserved.
- **Research Insights** (`#/research`): evaluation results and the reader-policy cost table.
- **Settings** (`#/settings`): "Blind-first for all cases" (a real control that changes `POST /reads`) and data provenance. *Activity* is deferred. `/api/audit` has real events, but a page for it needs more design (planned for cycle 3 if it earns its place).

Hash routing keeps the back and forward buttons working with no router dependency.

## 7. Name-conflict note (not a clearance)
A quick web search (Oct 2026) turned up two possible conflicts:
- **ClariPath Laboratories, Inc.** held US marks CLARIPATH and CLARIPATH LABORATORIES ("The Clear Choice in Pathology") for anatomical pathology lab services. The registrations we saw (filed 2006, Reg. 3237438 and 3237439) show as *cancelled (Section 8)*. Other filings may exist.
- **Clarapath, Inc.** (Hawthorne, NY) is a pathology lab-automation company (SectionStar, Crosscope software). The name is one letter away and the company is in the same domain, which makes confusion a real risk.

No software product named "Claripath" turned up. This is **not** trademark clearance. A professional search (USPTO/EUIPO plus common-law use) is needed before any public use. Because the brand lives in `frontend/src/brand.ts`, renaming is a one-file change.
