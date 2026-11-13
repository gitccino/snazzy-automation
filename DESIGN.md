# Settings interface

Standalone settings website, redesigned November 12, 2026 for a compact first visit. The latest minimal-design brief supersedes the earlier dark console treatment.

## Layout and hierarchy
A 76px brand header and a centered, maximum 1100px workspace. Desktop uses a 190px navigation rail, 56px gutter and flexible content column. At 800px the gutter narrows; at 600px navigation becomes a horizontally scrollable category row above the editor. Search spans the mobile width.

Connections opens with two provider rows. Provider fields are conditionally rendered on expansion; search reveals matching fields directly. Technical keys, connection diagnostics and system metadata are disclosures. Save/discard actions appear only for changed sections, in a sticky footer. Airtable impact review remains visible whenever its destination changes.

## Visual system
Google Sans, locally hosted. Neutral #fafafa canvas and white fields; #24272d text, #666d78 supporting text, #e4e6e9 dividers. Blue #315bc1 identifies focus and enabled switches. Primary save buttons use graphite. Red and amber are reserved for errors and change warnings. Typography is 14px body, 27px section titles, 12px supporting copy. Controls use 7px radii; provider groups 12px. Green-to-lime gradients are reserved for enabled switches, following the verified video reference. No glass or decorative animation.

## Interaction and accessibility
Explicit saves, persistent section drafts, revision-conflict recovery, network-failure draft retention, native inputs and switches. Focus outlines are visible. Short switch/chevron transitions respect reduced motion. Mobile inputs use 16px text and buttons at least 44px height. Long identifiers wrap in summaries and remain editable in input fields.

## Verification
10 component/API/access tests pass, TypeScript and production build pass. Desktop and 390px mobile rendering inspected, no page overflow. Mechanical design detector reported no findings. Review performed in-thread per the user's no-agent instruction. No production deployment or live provider validation in this redesign.

## Verified reference revision
Treg fetched https://www.threads.com/@dominikmartn/post/DfkEq0AylCC. Downloaded the 24-second video and inspected frames at 0, 8 and 16 seconds. Adopted its soft gray grouping surfaces, white inset rows, pill controls, black action buttons, subtle shadows and green/lime selected states. Kept the settings information architecture compact instead of copying the showcase montage. Current CSS reference block supersedes the earlier blue focus and angular controls.

## Appearance preference
Header select offers System (default), Light and Dark. Preference persists in localStorage; System follows live OS color-scheme changes. Dark uses #141613 canvas, green-gray surfaces, light text and lime focus. Provider cards, fields, warnings, success and error states all receive dark colors. At mobile widths the redundant environment chip is hidden to leave room for the selector; the sample workspace notice remains visible.

## Spacing refinement
4px spacing rhythm; 8px group inset with 20px inner and 28px outer radii. Provider rows use 16px horizontal / 20px vertical padding on desktop, 12px / 16px on mobile. Appearance uses a native select with an authored chevron inset 12px, 92px width and a 40px desktop / 44px mobile hit area. System details is a navigation category; its read-only grid and export are displayed only when selected. Removed the sidebar save hint. Category changes preserve drafts.

## Product numbering
Import contains a separate Product numbering section with the live next number, fixed A prefix, collision/backward validation and an explicit Save next number action. Drafts persist across category changes and warn on navigation away. Counter conflicts require reload; export settings retains the historical initial number and does not reset or restore the live sequence.
