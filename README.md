# Plan Well — Mobile Teen Progress & Habit Tracker

A high-performance, responsive web application designed for teens and young adults to set goals, build daily habits, track tasks, earn XP, and stay motivated.

Built with a futuristic deep-space cyan aesthetic, glassmorphic UI elements, and zero emoji clutter, Plan Well Mobile offers a seamless single-page application (SPA) experience optimized for smartphones and tablets.

---

## Key Features

### 21-Day Habit Psychology Protocol
- **Neural Rewiring Tracker:** Grounded in habit formation science, tracking 21 consecutive days to turn daily routines into permanent neural pathways.
- **Streak Counters & Level Milestones:** Earn a +500 XP Boost upon completing 21 days for any habit.
- **Instant Check-ins:** One-tap habit logging with streak visualization.

### Goals & Mission Planner
- **Micro-Step Breakdown:** Deconstruct long-term goals into actionable micro-steps.
- **Direct Habit Linking:** Connect specific micro-steps directly to daily habit routines with auto-prefilled goal parameters.

### Task Board & To-Dos
- **One-off Quick Actions:** Organize homework, projects, and personal tasks.
- **Goal & Habit Support:** Link tasks directly to larger goals or daily habits.
- **Overdue Warnings & Deadline Hints:** Color-coded deadline triggers and native date pickers.

### Activity Time Tracker
- **Integrated Timer:** Track time spent studying, reading, or working out.
- **Session History:** Log active sessions directly to your personal activity history.

### XP, Levels & Friends Leaderboard
- **Gamified Rewards:** Earn XP for habits checked, tasks completed, and goals achieved.
- **Level Progress & Unlocks:** Track level progression with glowing progress rings.
- **Friends Social Network:** Add friends via unique handles and compete on the live leaderboard.

### Authentication & Cloud Sync
- **Supabase Backend:** Secure email/password login, magic links, and Google OAuth integration.
- **Offline / Local Fallback:** Full offline support using local storage caching.

---

## Tech Stack

- **Frontend:** HTML5, Modern CSS3 (Glassmorphism, CSS Custom Properties), Vanilla JavaScript (ES6+)
- **Icons & Visuals:** Scalable Vector Graphics (SVG), custom neon glow animations, HSL color system
- **Backend & Auth:** Supabase Client SDK (@supabase/supabase-js)
- **Local Server:** PowerShell / Python HTTP Server

---

## Project File Structure

```
mobile interface/
├── index.html           # Main Mobile Single-Page Application container
├── mobile-styles.css    # Mobile responsive layout, glassmorphic themes & touch targets
├── styles.css           # Core design system tokens, typography, and utility classes
├── app.js               # Primary application logic, state manager, and UI renderer
├── supabase-config.js   # Supabase backend URL and anon key configuration
├── LICENSE              # MIT License
├── README.md            # Documentation and setup guide
└── goals.html / habits.html / tasks.html / rewards.html # Redirect proxies
```

---

## Getting Started

### Running Locally
To launch the mobile interface locally on port 8081:

Using PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File server.ps1 -Port 8081 -SubFolder "mobile interface"
```
Or using Python:
```bash
python -m http.server 8081 --directory "mobile interface"
```

Open your browser at: http://localhost:8081

---

## License

Distributed under the MIT License. See LICENSE for details.
