# Community Connect — News & Announcements

A frontend-only community portal (WS101 Mini Capstone) for barangay news,
announcements, events, activities, and photo galleries. Built with plain
**HTML, CSS, and vanilla JavaScript** — no frameworks, no build step, no
backend. All data lives in `localStorage` in the browser.

| Home (light) | Home (dark) |
|---|---|
| ![Home page](docs/home.png) | ![Home page in dark mode](docs/home-dark.png) |

---

## How to run

- **Simplest:** double-click `index.html` (works from `file://`).
- **With PWA/offline support:** serve the folder over HTTP, e.g.
  - `python -m http.server 8000` → open `http://localhost:8000/`
  - or `npx serve .`

  The service worker (`sw.js`) only activates on `http://` or `https://`.

### Go Live (real-time streaming)

Everything above is fully static, but **Go Live** streams a live
camera/microphone broadcast from the admin to viewers on **other
computers**, which needs a tiny relay server. Run:

```
node server.js
```

Then:

- **Admin (broadcaster):** open `http://localhost:8787/admin.html` and
  click **Go Live**. Browsers only expose the camera on a *secure
  context*, and `localhost` counts as one, so use `localhost` for the
  admin even when viewers are on other machines.
- **Viewers:** open `http://<your-LAN-IP>:8787/user-dashboard.html` (the
  server prints the exact URL on startup). Live broadcasts appear at the
  top of the dashboard with a pulsing LIVE badge, live viewer count, and
  a running duration.

`server.js` has **zero dependencies** — it only uses Node's built-in
`http`, `fs`, `path`, `os`, and `crypto` modules. It serves the static
site like any other file server and additionally relays the live stream
over a hand-rolled WebSocket at the `/live` path.

**Without the server** (e.g. when you just double-click `index.html`),
Go Live still works but only **within the same browser** on the same
computer: the transport falls back to `BroadcastChannel`, a browser-native
messaging channel between tabs. Starting a broadcast in one tab makes it
live in every other tab of that same browser, but nothing is shared across
devices. Cross-computer streaming is LAN-only in this build.

## Accounts

| Role  | Username | Password   |
|-------|----------|------------|
| Admin | `admin`  | `admin123` |
| User  | —        | register at `register.html` |
| Official | `official` | `official123` (demo; the admin can add more) |

Admin panel: `admin.html` · User dashboard: `user-dashboard.html` ·
Barangay Official dashboard: `official-dashboard.html`

Residents and Barangay Officials share **one login form**
(`user-login.html`) — the account's role decides which dashboard opens.

---

## User guide

### For visitors (no account needed)

1. Open **Home** for the latest news, announcements, events, weather, and
   quick links.
2. Browse **News**, **Announcements**, **Events**, **Activities**, and
   **Gallery** — everything is readable without signing in.
3. Use **Search** to find anything across all content types at once
   (keyword + type filter chips).
4. On **Events**, switch between the **LIST** view and the month
   **CALENDAR** view; tap a day chip to jump to the matching event card.
5. On any news, announcement, or activity, use **SAVE** to bookmark it
   for later, **Like** it, comment from the detail popup, and share it
   from a feed card with the **Share** button (copies the link).
6. In a hurry? **Emergency Hotlines** (`hotlines.html`, also in the
   navigation) lists the barangay hall, police, rural health unit, fire
   department, and rescue unit with one-tap call buttons and a 911
   callout.
7. Toggle **EN / FIL** (language) and **DARK** (theme) from the top bar —
   both are remembered per browser.
8. Ask the **AI ASSISTANT** (`news-ai.html`) questions about posted
   community content.

### For residents (registered users)

1. Register at `register.html`, then sign in at `user-login.html`.
2. Your **user dashboard** (`user-dashboard.html`) shows the same content
   in one place, plus **Saved Items** and a **Notifications** section.
   Community News, Community Activities, and Announcements appear as
   **Facebook-style feeds**: full-width post cards where the author,
   **title, and caption come first** and the photo/video sits underneath,
   plus a
   **Like / Comment / Share / Save** action bar on every post, and
   infinite scroll that loads more posts as you scroll down. News posts
   can carry
   **several photos** (up to 6) laid out as a Facebook-style collage, and
   **several videos** (up to 3); activities and announcements support the
   same multi-photo + multi-video media. Videos can be uploaded from the
   admin form or linked by path/URL and play inline in the feed, the
   public lists, and the details popup. Uploaded videos are stored in
   **IndexedDB** (browser storage with a much larger quota than
   localStorage), so there is no practical video-size limit.
3. On **Events**, tap **I'M GOING** to RSVP; the button remembers your
   answer and the admin sees the headcount.
4. The **notification bell** in the header shows important announcements
   and upcoming events, newest first, with an unread dot until you open
   the panel.
5. Update your **display name**, **profile picture**, phone, address, and
   password under **My Profile** — your photo and name then appear on
   your comments and across the dashboard.
6. Open **REQUEST CERTIFICATE** to file a barangay certificate request
   online — **Barangay Certificate of Indigency**, **Barangay Clearance**,
   **Certificate of Residency**, **Certificate of Good Moral Character**,
   and **Barangay Business Clearance**. First **search for and select your
   barangay** in the searchable picker (type to filter, click to select) —
   the list shows **only the barangays the admin has created** (i.e. those
   that have an official account). A request is routed only to that
   barangay's office, so you cannot file against another barangay. Enter the
   purpose and details; a reference
   number (e.g. `CC-2026-12345`) is generated and the request appears under
   **My Certificate Requests** with a live status
   (**Pending → Ready for Pickup → Released**). Every submission
   automatically notifies only the Barangay Officials of the chosen
   barangay.
7. Open **REPORT INCIDENT** (also under **Barangay Services**) to report an
   accident or other emergency in your area. Pick the **incident type**
   (vehicular accident, fire, flood/typhoon, crime, medical, utility, or
   other), a **severity**, your **barangay**, the **location**, and a short
   **   description**. An `INC-2026-12345` reference is generated and the report
   appears under **My Incident Reports** with a live status
   (**Reported → Responding → Resolved**). Submitting it immediately notifies
   **every Barangay Official** (incident reports are emergencies, so they are
   not limited to one barangay) — whoever is on duty can respond.
8. If the admin publishes an **emergency broadcast** for your barangay, an
   **EMERGENCY ALERT** popup appears with the title, description, location, and
   safety instructions; a **30-second alarm** sounds and an **AI voice** reads
   the description. Tap **STOP ALARM** to silence your device (this does not
   cancel the alert for anyone else). The popup stays until the alert is
   resolved or expires. Set your **barangay** under **My Profile** so you
   receive the right alerts.
9. Open **COMMUNITY FEED** to post a **Lost Item**, **Found Item**, or general
   **Community Share** with photos and details, and browse what neighbors
   posted (newest first, filterable by All / Lost / Found / Shared). React with
   **Like**, discuss in **Comment**, **Share** the link, and **Save** posts.
   Lost/found posts with a matching barangay may be boosted by the admin or
   your Barangay Official into a community **alert banner** + bell
   notification.

### For Barangay Officials

1. The admin adds official accounts from **MANAGE USERS** in the admin
   panel; officials then sign in through the **same** login form
   (`user-login.html`) and are redirected to `official-dashboard.html`.
2. The **dashboard** shows pending requests, ready-to-print and released
   counts, total requests, and the latest submissions — **scoped to your
   own barangay** (an official only ever sees the requests addressed to
   the barangay they belong to).
3. **CERTIFICATE REQUESTS** lists your barangay's requests with search,
   **status / type / date-range filters**, and a checkbox column for **bulk
   mark-as-ready**. Click **REVIEW** to see the applicant's details and use
   **MARK AS READY**, **PRINT CERTIFICATE**, or **REJECT with remarks** (the
   reason is shown to the resident). Before printing you can record **who
   claimed it and an ID/reference**; printing opens a clean A4 certificate
   built from the request and marks it **Released**, recording who printed it.
   **EXPORT LOG** downloads a CSV of your barangay's certificate log.
4. A certificate request for your barangay shows up instantly in the
   header **notification bell** — open it to jump straight to the request.
   Routing is strictly per-barangay: a request appears only in the
   dashboard, stats, and notification bell of the officials of the
   **barangay the resident selected**, and **MARK ALL READ** only clears
   your own barangay's alerts — other barangays keep theirs.
5. **INCIDENT REPORTS** lists the accidents and emergencies reported by
   residents, with search plus **status, severity, and date-range filters** and
   a priority queue (escalated first, then by severity). Click **REVIEW** to
   **CLAIM** a report, add timestamped **updates** (shown to the resident or
   kept internal), and **MARK AS RESPONDING / RESOLVED**. The dashboard adds an
   **Incident Response** panel (open / escalated counters, average response
   time, incidents-by-type chart), a **High-severity** alert sound, and an
   **Incident CSV** export. Each new report arrives instantly in the header
   **notification bell** (filter by All / Incidents / Certificates) — incidents
   reach **every** official, not just one barangay.
6. **The community is exactly what residents see.** The sidebar adds the
   same sections as the member dashboard: **COMMUNITY NEWS**,
   **ANNOUNCEMENTS**, and **ACTIVITIES** as **Facebook-style feeds** (post
   cards with Like / Comment / Share / Save), plus **UPCOMING EVENTS**
   (with RSVP) and the **GALLERY** lightbox. Officials can react, comment,
   save, and RSVP using their official identity — the same interactive
   features residents get.
7. **My Profile** lets an official update their own name, photo, email,
   phone, and password.
8. **COMMUNITY FEED** shows the residents' Lost & Found and community posts,
   where officials can Like / Comment / Share / Save and, on a lost/found post,
   use **ALERT COMMUNITY** to broadcast a dismissible alert banner + bell
   notification to **all barangays or one barangay** so everyone can help.

### For administrators

1. Sign in at `admin-login.html` (`admin` / `admin123`).
2. The **dashboard** shows content stats, charts (content mix, posts per
   month, news views per day), and a **Recent Admin Activity** audit log.
   All configuration lives in the header **Settings** gear (see step 8).
3. **Manage Content** sections (News, Announcements, Events, Activities,
   Gallery) each have an add/edit form with image upload + live preview
   and a searchable table with inline thumbnails. News, Announcements,
   and Activities forms also accept **multiple photos** (up to 6, as a
   collage) and **multiple videos** (up to 3, stored in IndexedDB).
   Pin/feature news to the top of the public list.
4. **MANAGE USERS** is the account hub: the top section creates and
   manages **Barangay Official** accounts (full name, barangay, username,
   password, optional email/phone) — open an entry to **EDIT** it,
   **DEACTIVATE**/**ACTIVATE** it to enable/disable sign-in, or
   **DELETE** it. Below the official tools is the **Registered Users**
   list of residents; open a profile to see activity counts or delete an
   account with its saved data. Officials sign in on the same login form
   as residents but land on the official dashboard.
5. **COMMENTS** (Facebook-style) shows comment threads grouped per post —
   each thread is labelled **NEWS**, **ANNOUNCEMENT**, or **ACTIVITY** —
   view the commenter's profile, **HIDE** a comment, or **DELETE** it.
   Hidden comments disappear from the public site immediately.
6. The **events table** tracks attendance: the **Going** chip on each row
   opens the list of residents who RSVP'd, and the strip above the table
   summarises upcoming events, total RSVPs, and the biggest gathering.
7. The **notification bell** aggregates new comments, new registrations,
   and content activity for admins too.
8. **Settings** (gear in the header, between Dark Mode and the bell) is the
   admin control centre, organised into tabs:
   - **General** — theme (Light / Dark / System), language, site title,
     site name, **logo** upload, and **maintenance mode** (shows a notice
     bar on the public site).
   - **Notifications** — per-type toggles that decide which activity alerts
     the bell.
   - **Security** — **change the admin password** and set an
     **auto-logout** timeout for inactivity.
   - **Data & Backup** — backup reminder/frequency/retention plus the
     **EXPORT JSON / IMPORT JSON / EXPORT NEWS CSV / RESTORE LAST RESET**
     tools and a **Danger Zone** reset (a safety backup is saved so you can
     undo it).
   - **Users** — account counts and shortcuts into **Manage Users** and
     **Notifications** (it never duplicates that table).
   Everything is saved to `communityAdminSettings` and applied live.
9. **My Profile** (in the sidebar) sets your **profile picture**,
   display name, title/position, phone, and email — your photo and name
   are then shown beside every post you publish.
10. **Go Live** streams your camera and microphone to everyone on the
    network in real time. Click **GO LIVE** on the dashboard to open the
    studio: enable the camera, set a title/description/category, and press
    **Start Broadcast**. Viewers see it at the top of their dashboard with
    a live badge, viewer count, and duration. Check **Save a recording**
    to keep a copy in **Live Archives** (stored in IndexedDB) for
    on-demand playback later. Requires `node server.js` — see
    [Go Live](#go-live-real-time-streaming).
11. **EMERGENCY BROADCAST** (next to GO LIVE) opens the emergency studio:
    set a **title**, **type**, **affected barangay** (one barangay or **All
    Barangays**), **location**, **description**, **safety instructions**, and
    an **expiry**. Publishing instantly shows an **EMERGENCY ALERT** popup with
    a 30-second alarm + AI voice on the matching residents' and officials'
    dashboards. **Active Broadcasts** lists live alerts with a **RESOLVE**
    button; resolving (or expiry) removes the popup from every dashboard.
12. **COMMUNITY POSTS** lists every resident post (Lost & Found + shares) with
    search and a type filter; **VIEW** opens it, **HIDE** pulls it from the
    feed (and back), and **DELETE** removes it with its comments. **ALERT
    COMMUNITY** on a post sends a dismissible banner + bell notification to
    **all barangays or one barangay**. Live alerts are listed under
    **Community Alerts** with a **CLEAR** button.

---

## Features

- **Content:** news, announcements, events (with RSVP + calendar view),
  activities, gallery (lightbox), emergency banner, weather card with
  forecast, contact form, News AI chat assistant, emergency hotlines
  directory.
- **Barangay Officials & certificate services:** the admin adds and
  manages official accounts (add / edit / activate / deactivate /
  delete, each assigned to a **barangay**), and each official has a
  dedicated **official dashboard**. Residents file certificate requests
  online — **Barangay Certificate of Indigency**, **Barangay Clearance**,
  **Certificate of Residency**, **Certificate of Good Moral Character**,
  and **Barangay Business Clearance** — choosing their barangay with a
  **searchable picker** that lists **only the barangays the admin has
  created**; the request is routed **only to that barangay's
  office** and the resident cannot file against a different barangay.
  Every submission **automatically notifies** the matching officials
  (header bell + dashboard), who review the request and click **PRINT
  CERTIFICATE** to open a clean A4 certificate built from the request;
  printing marks it **Released** and records who issued it. Officials only
  ever see their own barangay's requests, and their dashboard mirrors the
  resident experience for community content — the same **Facebook-style
  feeds** (Community News, Announcements, Activities), **Upcoming Events**
  with RSVP, and the **Gallery** lightbox, with working Like / Comment /
  Share / Save under an official identity. Residents and officials
  use **one shared login form** and are redirected by role — and the two role
  sessions are independent, so a resident can report an incident while the
  barangay official keeps their dashboard open in another tab (the login form
  shows who is active but stays usable for the other role).
- **Incident reporting (Barangay Services):** residents report accidents and
  other emergencies in their area — type, severity, barangay, location, and a
  description — straight to the matching Barangay Officials. Each report gets
  an `INC-YYYY-#####` reference, tracks a live status
  (**Reported → Responding → Resolved**), and appears immediately on the
  officials' dashboard (**Active Incidents** stat + recent list), in their
  **INCIDENT REPORTS** table, and in the header **notification bell**.
  Because incidents are emergencies, every Barangay Official receives them
  (certificate requests remain strictly per-barangay).
- **Official response toolkit:** an **On Duty** toggle in the header; a priority
  queue that sorts incidents by escalation (still `Reported` after 15 min) then
  severity; **severity chips** and highlighted escalated rows; a **Claim**
  action (assigned-to); a timestamped **response timeline** with updates that
  can be marked **visible to the resident** (or kept as internal notes); a
  **response-time KPI**, open/escalated counters, and an **incidents-by-type**
  chart; **photo** and **GPS/landmark** support on reports with a **View on
  map** link; incident **CSV export**; certificate **reject with remarks**,
  **release capture** (who claimed it + ID), **type/date-range filters**, **bulk
  mark-ready**, and a **release log CSV**; and notification **filter tabs**
  (All / Incidents / Certificates) with **high-severity priority styling** and a
  mute-able **alert sound**.
- **Emergency broadcast:** the admin publishes an emergency alert (**title,
  type, location, complete description, safety instructions**) to **one
  barangay or all barangays**, with an **expiry**. Residents and Barangay
  Officials of the affected barangay instantly get a prominent **EMERGENCY
  ALERT popup** showing the title, description, location, and safety
  instructions, plus a **30-second alarm** and an **AI voice** that reads the
  description aloud. Each viewer has a **STOP ALARM** button that silences
  their own device only (the broadcast is not cancelled and other users are
  unaffected), and a **REPEAT ANNOUNCEMENT** button. The full popup **stays
  visible** until the admin **resolves** it or it **expires**; if it is
  minimized to the top **banner**, that banner **auto-dismisses when the alarm
  finishes**. Delivery is real-time across tabs, and residents set their
  **barangay** in **My Profile** to receive targeted alerts.
- **Community feed + Lost & Found:** residents publish **Lost Item / Found
  Item / Community Share** posts (title, description, item type, last-seen
  location, date, contact, up to **4 photos**) to a shared, Facebook-style
  feed visible to all residents and officials, newest first, with **Like /
  Comment / Share / Save** and filter chips (All / Lost / Found / Shared).
  Comments reuse the shared comment pipeline, so they also show up in the
  admin **COMMENTS** moderation. The admin monitors every post under
  **COMMUNITY POSTS** (view / **hide** / **delete**), and both the admin and
  Barangay Officials can **ALERT COMMUNITY** about a lost item — choosing
  **all barangays or one barangay** — which shows a dismissible blue banner +
  a bell notification on the matching member/official dashboards, in real time.
  The latest Lost & Found posts also appear in a compact **Lost & Found** panel
  on the **Home / Overview** of the member, official, **and** admin dashboards,
  each with a **VIEW ALL** link into the full feed/moderation. Each of the
  author's own posts has a **three-dot (⋮) menu** in the top-right with **Edit
  post** and **Delete post** (delete asks to confirm; edit updates the title,
  description, item type, location, date, and contact); a **DELETE MY POST**
  button also appears in the post's detail popup. The admin can delete any post
  from **COMMUNITY POSTS**.
- **Dashboard settings:** settings live in the **account menu** (click the
  name in the header), not a separate header button. Members and officials
  get a quick **Settings** panel with **Dark Mode** and **Language**; the
  admin gets a full tabbed **Admin Settings** hub (General, Notifications,
  Security, Data & Backup, Users) described in the admin guide. Settings
  persist in `communityAdminSettings` and apply live.
- **Theme pill:** the dashboard header theme toggle is a pill showing the
  current mode — a yellow **moon + "Dark"** or an orange **sun + "Light"**.
- **Account menu:** clicking the **name** in any dashboard header opens a
  dropdown with the signed-in **name + email + avatar**, then **My Profile**
  and **Settings** (plus **Sign Out**). All three roles share the same
  menu, so profile editing and settings are one click away.
- **Notification centre (admin):** a Facebook-style bell with an unread
  **count badge** and a dropdown fed by **real user activity only** —
  every like, comment, share, save, RSVP, sign-up, and Go Live broadcast
  is recorded with the resident's name, profile picture, the related
  post, and a relative timestamp ("2m", "4h", "3d"). Notifications are
  stored in `localStorage` so they survive refreshes and re-logins,
  update **in real time across tabs** (BroadcastChannel with a storage
  fallback), and are clickable — tapping one opens the related post,
  comment thread, event attendee list, or member profile. A dedicated
  **Notifications** section provides the full history with All/Unread
  filters, **mark one / mark all as read**, clear history, and
  **per-type settings** that control what alerts the bell. Nothing is
  faked: a fresh install shows an empty bell until a resident acts.
- **Profiles:** members, the admin, and Barangay Officials can set a
  **display name** and upload a **profile picture** (cropped square,
  auto-compressed to 256px and stored locally). The profile page is a
  **centered, widened card** grouped into identity / contact / password
  sections with a profile-picture panel, and each card has a
  circular **X** that closes it (back to the dashboard); saving shows a
  "Your profile has been saved successfully." banner at the top that fades
  after 2 seconds and then refreshes the page automatically. Photos and
  names appear in the dashboard header
  and sidebar, beside every post the admin publishes, on comment
  threads, in event attendee lists, and in the admin MANAGE USERS table — with
  coloured initials as the fallback when no photo is set.
- **Resident engagement:** **logged-in or guest** visitors can post
  **comments** and **Like** reactions on news, announcements, and
  activities — from the feed cards or the detail popup. Guests just type
  a display name (optional) and can react once per browser; members get
  their username attached. The admin COMMENTS panel moderates every
  thread with a type label per post (news / announcement / activity) and
  a GUEST badge for anonymous comments, while comment counts and like
  totals stay in sync across cards.
- **RSVP & attendance tracker:** registered users confirm attendance on
  event cards ("I'M GOING"); the admin events table then shows a
  clickable **Going** headcount chip per event, an attendance summary
  strip (upcoming events · total RSVPs · biggest gathering), and an
  attendee list in the detail popup.
- **Global search:** dedicated `search.html` searches news,
  announcements, events, activities, and gallery captions at once, with
  type filter chips and `<mark>` highlighting.
- **Notifications:** header bell + dropdown panel on both admin and user
  dashboards (comments, registrations, announcements, events), unread
  dot, "mark seen" model, and full Notifications section in the user
  dashboard.
- **Admin COMMENTS:** Facebook-style moderation — threads grouped per
  post, commenter avatars, VIEW PROFILE / HIDE / DELETE actions, live
  search, and comment-count badges in the News table.
- **Audit log:** every admin action (create/update/delete per content
  type, hide/delete comment, import/reset/restore) is logged and shown
  as "Recent Admin Activity" on the dashboard.
- **Data safety:** `localStorage` schema versioning with automatic
  migrations on startup, validated JSON imports (app name, schema
  version, per-key shape), auto-backup snapshot saved on reset with
  one-click restore.
- **Search & filters:** live keyword search with highlighting, category
  and date-range filters on news, category + keyword on announcements,
  and shareable URL state (`news.html#q=…&cat=…&date=…`).
- **Toasts:** every action (save/delete/post/export) shows an accessible
  toast instead of blocking `alert()` dialogs. Toasts appear in the
  **top-right corner** (below the header), stacked and colour-accented by type
  (green success / red error / blue info), on the member, official, admin, and
  public pages alike.
- **Bookmarks & comments:** save news/announcements, post comments, RSVP
  to events — all per-user in `localStorage`.
- **Admin analytics:** per-day news view chart (7 days), content-by-type
  and posts-per-month charts, **pin/feature** news with a FEATURED
  badge, and **CSV export** (`exportNewsCsvBtn`).
- **Go Live:** real-time camera/mic streaming from the admin to every
  viewer. `MediaRecorder` captures 1-second chunks that are relayed to
  all connected viewers, where `MediaSource` appends them for near-live
  playback. The transport is dual: a WebSocket relay (`server.js`) for
  cross-device streaming on the network, with an automatic
  `BroadcastChannel` fallback for same-browser use when no server is
  running. Late joiners get the stream header so they can start playing
  immediately, a stall watchdog flips the player back to a friendly
  "interrupted" overlay if the stream stops, and the broadcast ends
  automatically if the admin tab closes. Optional recordings are saved
  to IndexedDB under **Live Archives**.
- **Admin tables:** every Manage Content table has a live search box
  with a matching item count, sensible ordering (pinned news first,
  soonest events first, otherwise newest first), inline row thumbnails,
  and live image preview in the forms.
- **Deep links:** `news.html#article-<id>`, dashboard sections open from
  URL hash (`user-dashboard.html#saved`), back-to-top button.
- **i18n:** full English/Filipino toggle (`EN / FIL`) covering static
  chrome and all dynamically rendered content (dates, badges, forms,
  dashboard, admin, empty states, calendar months).
- **Accessibility:** skip link, `aria-expanded`/`aria-current`, focus
  trap in modals, Escape-to-close, focus restoration, visible
  `:focus-visible` styles, `prefers-reduced-motion` support.
- **SEO:** unique meta descriptions, canonical URLs, Open Graph/Twitter
  cards, and JSON-LD (WebSite, Organization, BreadcrumbList).
- **PWA:** installable manifest + icons, service worker precaching, and
  an `offline.html` fallback for pages not yet cached.
- **Mobile view:** a dedicated phone/tablet experience. The public site
  gets a fixed **bottom tab bar** (Home · News · Alerts · Events · Menu)
  with an active indicator and a compact topbar; the dashboards get a
  sliding **drawer** with a dimming backdrop, page-scroll lock,
  close-on-select, Escape and swipe-to-dismiss; admin tables turn into
  **stacked cards** with labelled fields instead of horizontal scroll;
  and modals open as **bottom sheets** with full-width buttons. All
  layouts hold up with no horizontal overflow from 360 px up.
- **Mobile-first:** no horizontal overflow at 375 px, slide-in
  navigation, 16 px form inputs (no iOS zoom), comfortable touch
  targets.
- **Dark mode:** **dark is the default theme** (the premium glass look);
  the header toggle switches to light and is remembered per browser. Full
  parity across public, user, and admin pages.
- **Premium glass UI — the whole website:** every page (public site +
  admin, member, and official dashboards) uses the same modern
  glassmorphism design (section 77 in `css/style.css`) — an animated
  **mesh-gradient background**, **frosted headers and sidebars**, gradient
  active nav pills, glass cards/panels/feeds, **gradient stat cards**, and
  **vivid gradient event cards** with circular glass countdown badges, plus
  softer inputs, tables, buttons, and footers. Full light-theme parity and
  reduced-motion support.
- **UI polish:** a system-wide design layer (section 57 in `css/style.css`)
  with shared tokens for radii, layered shadows, timing, and easing; a
  redesigned **deep-blue navigation rail** for the dashboards (section 60)
  with bright section headings + dividers, larger touch rows, and a clear
  active state (blue pill, white edge bar, white icon tile);
  proper inline SVG icons in the admin/member sidebars and dashboard stat
  cards; pill topbar toggles and filter chips; refined buttons, cards,
  forms, tables, modals, toasts, and feed cards; soft hover/focus states
  everywhere; slim custom scrollbars; and full dark-mode parity. Motion
  respects `prefers-reduced-motion`, and every page holds up with no
  horizontal overflow from 375 px up.
- **Dashboard Quick Actions:** every dashboard overview (member, official, and
  admin) opens with a **Quick Actions** grid of large, icon-labelled tiles for
  the role's most common tasks (Create a Post / Report Incident / Request
  Certificate / Hotlines; Incident + Certificate queues / Community Feed / View
  Website; Add News / Add Announcement / Community Posts / Manage Users), so the
  main tasks are always one tap away on desktop and mobile.

| Search | Calendar |
|---|---|
| ![Global search page](docs/search.png) | ![Events calendar view](docs/calendar.png) |

| Admin — Manage Comments | User dashboard + notifications |
|---|---|
| ![Admin comments moderation](docs/admin-comments.png) | ![User dashboard with notifications](docs/user-dashboard.png) |

---

## Architecture

| File / folder | Role |
|---|---|
| `index.html` | Home: hero, quick links, weather, latest content, features |
| `news.html` | Facebook-style news feed + search, category/date filters, share state |
| `announcements.html` | Announcements list + category/keyword filter |
| `events.html` | Events + RSVP, LIST ⇄ CALENDAR toggle, month grid |
| `activities.html` | Community activities |
| `gallery.html` | Photo gallery + lightbox |
| `contact.html` | Contact form |
| `hotlines.html` | Emergency hotlines directory — barangay, police, health, fire, and rescue numbers with quick-dial (`tel:`) and copy buttons |
| `news-ai.html` | News AI chat assistant |
| `search.html` | Global search across all content types |
| `about.html` | About showcase: gradient hero with quick stats, glass purpose panel, mission/vision cards, feature tiles, project team, and a call-to-action band (section 79 in `css/style.css`) |
| `admin-login.html` / `user-login.html` / `register.html` | Auth pages. `admin-login.html` uses the **Glass Admin Portal**: a full-viewport animated gradient (indigo → blue drifting over 15s) with soft floating particles and a frosted **glassmorphism** card - an amber *Admin Access Only* badge, a lock mark, the **Admin Portal** heading and subtitle, icon-led username/password fields, a *Keep session active* toggle, and the **Authenticate Admin Portal** button - wired to the real `admin`/`admin123` auth flow and the 5-try login limiter. `user-login.html` uses the **VERSO design**: a card-only, full-viewport page (no site topbar/nav/footer) with an ivory/cream (`#F5F2EA`) card split by a deep forest-green (`#0b2218`) skewed "blade" with Playfair serif headings, sliding between **Sign In** ("Welcome back, Resident.") and **Create Account** ("Stay Informed. Stay Connected."). The page is dressed with colourful accents: ambient emerald/teal/gold/sunset background washes, a rainbow strip along the card's top edge, jewel-tone glows inside the blade, tri-colour title underlines and blade seam, gradient italic headlines, and emerald focus/link/button treatments. Both forms are wired to the real auth flow, and sign-ups/sign-ins are mirrored into the `registeredUsers` and `userLogin` LocalStorage keys |
| `admin.html` | Admin: dashboard, charts, content CRUD, **MANAGE USERS** (create/manage Barangay Officials + registered residents), COMMENTS, audit log, backup tools, **Go Live studio**, **Emergency Broadcast studio** (publish / resolve alerts), **COMMUNITY POSTS** (Lost & Found moderation + community alerts) |
| `user-dashboard.html` | User: overview, browse, saved items, notifications, **Barangay Services** — **certificate requests** (file + track) and **incident reports** (report + track), profile (incl. **barangay**), **live broadcast player**, **emergency alert popup** (30s alarm + AI voice), **Community Feed** (Lost & Found composer + Like/Comment/Share/Save) |
| `official-dashboard.html` | Barangay Official: request + incident stats, on-duty toggle, **certificate requests** (review / mark ready / reject / release capture / **print** / bulk / export), **incident reports** (claim / response timeline / severity + escalation / CSV), incident-response KPIs + chart, the same **Facebook-style community feeds** as residents (**Community News**, **Announcements**, **Activities** + **Upcoming Events** RSVP + **Gallery** lightbox) with Like / Comment / Share / Save, filterable notification bell (All / Incidents / Certificates) with alert sound, **My Profile**, the **Community Feed** (Lost & Found, with **ALERT COMMUNITY**), and the **emergency alert popup** (30s alarm + AI voice) |
| `offline.html` | Offline fallback page |
| `manifest.json`, `sw.js` | PWA manifest + service worker (cache v35) |
| `server.js` | Optional zero-dependency Node server: static file hosting + WebSocket relay for Go Live |
| `css/style.css` | All styles, numbered sections, dark theme, print, reduced-motion, the section 57 polish layer with design tokens, the section 58 mobile view, the section 60 sidebar rail redesign, and the section 67 VERSO auth card |
| `js/script.js` | All logic: i18n, renderers, admin, comments, notifications, audit, migrations, toasts, charts, Go Live transport + player, **Barangay Officials + certificate services** |
| `icons/`, `images/` | PWA icons + sample content images |
| `docs/` | README screenshots |
| `tests/e2e.html` | End-to-end test suite (706 assertions) |
| `tests/e2e-run.cjs` | Headless runner for the suite: launches Chrome via the DevTools Protocol, waits for real completion, and prints the pass/fail tally |
| `tests/relay-test.cjs` | Headless test for `server.js`: static serving, path-traversal guard, and WebSocket relay of text + binary frames |

### Key internal modules in `js/script.js`

| Area | What it does |
|---|---|
| `I18N_MAP` / `t()` / `walkI18nText` | English ↔ Filipino translation engine for static + dynamic content |
| `loadList` / `setData` | Typed localStorage access with sample seeding |
| `drawNewsList` / `filterNews` (and siblings) | Public news feed rendering + search/filter + empty states |
| `renderNewsFeedCard` / `renderActivityFeedCard` / `renderAnnouncementFeedCard` / `drawFeedList` / `setupFeedObserver` | Facebook-style feeds (dashboard news + activities + announcements, and the public news page): post cards, likes, share, infinite scroll |
| `newsMediaHtml` / `initNewsVideoUpload` / `initActivityVideoUpload` / `initAnnVideoUpload` / `getNewsImages` / `getMediaImages` / `getMediaVideos` | News + announcements + activities post media: photo collage (2-6 images) and/or inline `<video>` players (up to 3, upload + path/URL), rendered in feed, list, and detail popup |
| `openVideoDb` / `saveVideoBlob` / `videoSrcFromRef` / `resolveVideoRefs` | IndexedDB video store: raw uploaded video files live here (no size limit), while the post record only holds a tiny `idb:` reference that the renderer swaps for a playable blob URL |
| `renderWeatherCard` | Sample weather + forecast + advisories with SVG icon |
| `initEventsCalendar` / `renderEventsCalendar` | Month grid with event chips, Filipino month names |
| `initGlobalSearchPage` | Cross-content search with type chips + highlighting |
| `initNotifBells` / `buildAdminNotifications` / `renderNotifPanel` | Header bell, unread dot, dropdown panels |
| `renderAdminComments` / `toggleCommentHidden` / `deleteAdminComment` | Facebook-style moderation |
| `logAudit` / `renderAuditLog` | Admin action trail |
| `avatarFor` / `avatarInner` / `compressAvatar` / `displayNameFor` / `initAvatarPicker` | Profile pictures + display names: square-crop upload, initials fallback, and name resolution used by feeds, comments, and the dashboards |
| `renderCommentsHtml` / `refreshCommentCounters` / `findCommentedPost` / `renderAdminComments` | Comments on news, announcements, and activities with per-type moderation threads |
| `notifyAdmin` / `buildAdminNotifications` / `openNotification` / `renderNotificationHistory` | Notification centre: real-action store, unread counts, clickable rows, history filters, per-type preferences, and cross-tab real-time updates |
| `renderRsvpSummary` / `showEventAttendees` | Admin attendance tracker: headcount summary, Going chips, and attendee lists |
| `HOTLINES` / `renderHotlinesPage` / `injectHotlinesLinks` | Emergency hotlines directory with quick-dial and copy buttons, linked from every public nav and footer |
| `renderBottomNav` / `initMobileDrawer` / `togglePublicNav` | Mobile view: public bottom tab bar, dashboard slide-in drawer with backdrop/scroll-lock/swipe, and the shared nav toggle |
| `runMigrations` / `importFromFile` / `resetAllData` / `restoreAutoBackup` | Schema versioning, validated imports, reset + auto-backup |
| `loadOfficials` / `saveOfficials` / `initOfficialsAdmin` / `editOfficial` / `toggleOfficialActive` / `deleteOfficial` | Admin management of Barangay Official accounts (add / edit / activate / deactivate / delete) |
| `CERT_TYPES` / `barangayOptions` / `initBarangayPicker` / `initUserCertificates` / `renderMyRequests` / `addOfficialNotification` / `openCertRequestDetail` / `markCertRequestReady` / `printCertificate` | Certificate services: the request types, the **searchable barangay picker** (shared with incidents), the resident request form + tracking table, barangay-routed notifications, and the official review → ready → printable-A4 (released) flow |
| `INCIDENT_TYPES` / `initUserIncidents` / `renderMyIncidents` / `addIncidentNotification` / `renderOfficialIncidents` / `openIncidentDetail` / `setIncidentStatus` | Incident reporting: accident/emergency types + severities, the resident report form (photo + GPS/landmark) + tracking table, notifications to **all** officials (emergencies aren't barangay-limited), and the official claim / update / responding → resolved flow |
| `claimIncident` / `addIncidentNote` / `incidentTimelineHtml` / `incidentEscalated` / `renderOfficialIncidentAnalytics` / `exportIncidentsCsv` / `renderOfficialDutyUi` / `playIncidentAlert` | Official response toolkit: claim + assigned-to, timestamped timeline updates (resident-visible or internal), escalation flagging, response-time + by-type analytics, incident CSV, on-duty toggle, and high-severity alert sound |
| `rejectCertRequest` / `markSelectedRequestsReady` / `exportReleasedCsv` | Certificate admin actions: reject with remarks, bulk mark-as-ready, and a release-log CSV export |
| `EMERGENCY_TYPES` / `publishEmergency` / `resolveEmergency` / `currentEmergencyFor` / `emergencyMatches` / `startEmergencyAlarm` / `speakEmergency` / `renderEmergency` / `initEmergencyBroadcast` / `initAdminEmergency` | Emergency broadcast: admin publish/resolve to one barangay or all, barangay-scoped popup on member + official dashboards, a 30-second Web Audio alarm, AI voice (SpeechSynthesis) reading the description, per-device STOP ALARM, minimize-to-banner persistence, and real-time delivery |
| `POST_KINDS` / `loadUserPosts` / `renderCommunityFeed` / `renderUserPostCard` / `initUserPostComposer` / `toggleUserPostLike` / `toggleUserPostSave` / `shareUserPost` / `openUserPostDetail` / `renderAdminPosts` / `setUserPostHidden` / `deleteUserPost` / `raiseCommunityAlert` / `renderCommunityAlertBanner` | Community feed + Lost & Found: resident composer (Lost/Found/Share + photos), Facebook-style feed with Like/Comment/Share/Save (comments via the shared pipeline), admin view/hide/delete moderation, and targeted community alerts (all / one barangay) shown as a dismissible banner + bell notification |
| `requireOfficialLogin` / `showOfficialSection` / `renderOfficialDashboardStats` / `renderOfficialRequests` / `renderOfficialCommunity` / `initOfficialProfile` / `getActor` | Barangay Official dashboard: auth guard, sections, barangay-scoped request stats/table, the shared Facebook-style community feeds + events + gallery, notification bell, self-service profile, and the official interaction identity |
| `initLiveTransport` / `initLiveStudio` / `initLivePlayer` | Go Live: dual WebSocket + BroadcastChannel transport, admin broadcast studio, and MediaSource viewer player |
| `I18N_PH` near map end | Filipino phrase table (incl. audit/admin actions) |

---

## Tests

The whole suite runs in hidden iframes and prints a PASS/FAIL list plus an
`E2E DONE: n/m` summary line (currently **706/706**). It seeds its own
test users/data and does not touch your real accounts (over `file://` it
reuses the current origin's storage, so run it from a clean profile if in
doubt).

**Recommended — headless via the DevTools Protocol** (waits for real
completion, so IndexedDB and other async work resolve deterministically):

```
node tests/e2e-run.cjs
```

Set `CHROME_PATH` if Chrome is not in a standard location, and `PORT` /
`TIMEOUT_MS` if needed. The runner exits non-zero on any failure.

**Or open `tests/e2e.html`** normally in a desktop browser. A quick
`chrome --dump-dom --virtual-time-budget=…` run also works but can report a
partial tally because Chrome's virtual clock races real async work.

The Go Live **relay server** is tested separately (it runs on Node, not in
the browser). With the suite's dependencies installed, run:

```
node tests/relay-test.cjs
```

It starts `server.js` on a spare port and checks that static pages are
served, that path traversal is blocked, and that the `/live` WebSocket
relays text (JSON control) and binary (media) frames between two clients
without echoing them back to the sender, including a 70 KB frame that
exercises the multi-byte length encoding.

Not covered by the suite: CSV/JSON **downloads** (headless Chrome blocks
them), the service-worker flow (requires HTTP; verified separately), and
real camera capture in Go Live (needs hardware; the transport and
relay are covered by `relay-test.cjs` and the 14e UI checks).

---

## Data storage

Content is saved under `community*` keys in `localStorage`, e.g.
`communityNews`, `communityAnnouncements`, `communityEvents`,
`communityActivities`, `communityGallery`, `communityRsvps`,
`communityBookmarks`, `communityComments`, `communityUsers`,
`communityViews`, `communityViewLog`, `communityAuditLog`,
`communityLiveArchive`, `communityAdminProfile`, `communityGuestLikes`, `communityNotifications`, `communityNotificationPrefs`,
`barangayOfficials`, `certificateRequests`, `communityOfficialNotifications`,
`incidentReports`, `communityEmergencyAlerts`,
`communityUserPosts`, `communityUserAlerts`, `communitySchemaVersion`,
`communityLang`, `communityTheme`.

- **Schema versioning:** `communitySchemaVersion` tracks the stored shape;
  `runMigrations()` upgrades older data automatically on startup (e.g.
  v1→v2 adds the `hidden` flag to comments; v7→v8 gives announcements the
  same `images`/`videos` arrays news and activities use; v8→v9 tags every
  comment with its `postType` so moderation can label news, announcement,
  and activity threads; v9→v10 adds the `barangayOfficials` registry,
  `certificateRequests`, and `communityOfficialNotifications`, seeding one
  demo official account `official` / `official123`; v10→v11 makes every
  official a "Barangay Official" with a `barangay`; v11→v12 tags each
  certificate request and its notification with the `barangay` the resident
  selected, so requests are routed to the right office; v12→v13 adds the
  `incidentReports` store for the Barangay Services incident reporting).
- **Backups:** `communityAutoBackup` is written by RESET DEMO DATA and
  can be restored with the RESTORE LAST RESET button.
- **Imports:** JSON files are validated (app name, schema version, per-key
  shape) before anything is written.

Use the **Settings → Data & Backup** tab to export/import JSON or
reset the demo data.
