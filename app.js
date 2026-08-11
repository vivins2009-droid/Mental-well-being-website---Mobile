const STORAGE_KEY = "goallab-user-tracker-v1";
const LOCAL_MIGRATION_KEY = `${STORAGE_KEY}-supabase-imported`;
const LEGACY_IMPORT_KEY = `${STORAGE_KEY}-legacy-imported`;
const SUPABASE_TABLE = "user_tracker_states";
const DEFAULT_CATEGORIES = ["Health", "School", "Money", "Friends", "Hobbies", "Home", "Adventure", "Community"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ALL_WEEKDAYS = DAYS.map((_, index) => index);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CALENDAR_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MS_PER_DAY = 86400000;

let selectedHabitDateKey = dateKey();
let editingCategoryName = "";
let pendingCategoryRemoval = "";
let pendingDeleteAction = null;
let editingRoutineLinkKey = "";
let editingGoalId = "";
let editingHabitId = "";
let editingTaskId = "";
let dateDocumentListenersBound = false;
let openReflectionKey = "";
let supabaseClient = null;
let authSession = null;
let currentUser = null;
let syncStatus = "Checking account...";
let syncTimer = 0;
let authInitialized = false;

function isLocalPreview() {
  const urlParams = new URLSearchParams(window.location.search);
  if (
    urlParams.get("testAuth") === "1" ||
    urlParams.get("showAuth") === "1" ||
    urlParams.get("login") === "1" ||
    localStorage.getItem("planwell_force_auth") === "1"
  ) {
    return false;
  }
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.endsWith(".local")
  );
}

if (new URLSearchParams(window.location.search).get("reset") === "1") {
  localStorage.removeItem(STORAGE_KEY);
  window.history.replaceState({}, "", window.location.pathname);
}

const state = createEmptyState();

function createEmptyState() {
  return { goals: [], habits: [], tasks: [], categories: [...DEFAULT_CATEGORIES] };
}

function normalizeStateSnapshot(raw) {
  const storedHasCategories = Object.prototype.hasOwnProperty.call(raw || {}, "categories");
  return {
    goals: Array.isArray(raw?.goals) ? raw.goals.map(normalizeGoal) : [],
    habits: Array.isArray(raw?.habits) ? raw.habits.map(normalizeHabit) : [],
    tasks: Array.isArray(raw?.tasks) ? raw.tasks.map(normalizeTask) : [],
    categories: storedHasCategories ? normalizeCategories(raw.categories, { allowEmpty: true }) : [...DEFAULT_CATEGORIES]
  };
}

function currentStatePayload() {
  return {
    goals: state.goals,
    habits: state.habits,
    tasks: state.tasks,
    categories: state.categories
  };
}

function applyState(nextState) {
  const normalized = normalizeStateSnapshot(nextState);
  state.goals = normalized.goals;
  state.habits = normalized.habits;
  state.tasks = normalized.tasks;
  state.categories = normalized.categories;
}

function stateHasUserData(snapshot) {
  const normalized = normalizeStateSnapshot(snapshot);
  return Boolean(
    normalized.goals.length ||
    normalized.habits.length ||
    normalized.tasks.length ||
    Object.prototype.hasOwnProperty.call(snapshot || {}, "categories")
  );
}

function accountCacheKey(userId) {
  return `${STORAGE_KEY}-account-${userId}`;
}

function readStoredState(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return normalizeStateSnapshot(stored);
  } catch {
    return createEmptyState();
  }
}

function loadState(key = STORAGE_KEY) {
  return readStoredState(key);
}

function writeStoredState(key, payload = currentStatePayload()) {
  localStorage.setItem(key, JSON.stringify(payload));
}

function saveState() {
  writeStoredState(currentUser ? accountCacheKey(currentUser.id) : STORAGE_KEY);
  if (isLocalPreview()) {
    writeStoredState(STORAGE_KEY);
  }
  queueRemoteSave();
}

function supabaseSettings() {
  const settings = window.PLANWELL_SUPABASE || {};
  const url = String(settings.url || "").trim();
  const anonKey = String(settings.anonKey || "").trim();
  const configured =
    url.startsWith("https://") &&
    anonKey.length > 20 &&
    !url.includes("PASTE_") &&
    !anonKey.includes("PASTE_");
  return { url, anonKey, configured };
}

function initSupabaseClient() {
  const settings = supabaseSettings();
  if (!settings.configured || !window.supabase?.createClient) {
    supabaseClient = null;
    syncStatus = settings.configured ? "Auth library unavailable" : "Supabase setup needed";
    return false;
  }
  supabaseClient = window.supabase.createClient(settings.url, settings.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
  return true;
}

function migrationKeyForUser(userId) {
  return `${LOCAL_MIGRATION_KEY}-${userId}`;
}

function setSyncStatus(message) {
  syncStatus = message;
  document.querySelectorAll("[data-sync-status]").forEach((element) => {
    element.textContent = message;
  });
  document.querySelectorAll("[data-account-chip] .profile-menu-copy span").forEach((element) => {
    element.textContent = userEmail() || "Signed in";
  });
}

function queueRemoteSave() {
  if (isLocalPreview()) {
    setSyncStatus("Saved locally (Local Preview)");
    return;
  }
  if (!authInitialized || !currentUser || !supabaseClient) return;
  window.clearTimeout(syncTimer);
  setSyncStatus("Saving...");
  syncTimer = window.setTimeout(() => {
    void saveUserState();
  }, 350);
}

async function loadRemoteState(userId) {
  if (!supabaseClient || !userId) return null;
  const { data, error } = await supabaseClient
    .from(SUPABASE_TABLE)
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data?.data || null;
}

async function saveUserState() {
  if (!supabaseClient || !currentUser) return;
  const payload = currentStatePayload();
  const { error } = await supabaseClient
    .from(SUPABASE_TABLE)
    .upsert({
      user_id: currentUser.id,
      data: payload,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

  if (error) {
    setSyncStatus("Saved locally - sync failed");
    return;
  }
  setSyncStatus("Saved to account");
}

async function bootstrapUserState(session) {
  authSession = session;
  currentUser = session?.user || null;
  window.clearTimeout(syncTimer);

  if (isLocalPreview()) {
    currentUser = {
      id: "local-preview-user",
      email: "local-preview@localhost",
      user_metadata: { full_name: "Local Preview User" }
    };
    authSession = { user: currentUser };
    const localSnapshot = loadState(STORAGE_KEY);
    applyState(localSnapshot);
    setSyncStatus("Local preview mode");
    return;
  }

  if (!currentUser) {
    applyState(createEmptyState());
    setSyncStatus("Signed out");
    return;
  }

  setSyncStatus("Loading account...");
  const accountCacheKeyName = accountCacheKey(currentUser.id);
  const accountSnapshot = loadState(accountCacheKeyName);
  const legacySnapshot = loadState(STORAGE_KEY);
  try {
    const remoteSnapshot = await loadRemoteState(currentUser.id);
    const importKey = migrationKeyForUser(currentUser.id);
    const legacyImportAlreadyUsed = localStorage.getItem(LEGACY_IMPORT_KEY) === "1";
    const shouldImportLocal =
      !remoteSnapshot &&
      !legacyImportAlreadyUsed &&
      stateHasUserData(legacySnapshot) &&
      localStorage.getItem(importKey) !== "1";

    if (remoteSnapshot) {
      applyState(remoteSnapshot);
      if (stateHasUserData(remoteSnapshot)) localStorage.setItem(LEGACY_IMPORT_KEY, "1");
      setSyncStatus("Loaded from account");
    } else if (shouldImportLocal) {
      applyState(legacySnapshot);
      localStorage.setItem(importKey, "1");
      localStorage.setItem(LEGACY_IMPORT_KEY, "1");
      await saveUserState();
      setSyncStatus("Imported local data");
    } else if (stateHasUserData(accountSnapshot)) {
      applyState(accountSnapshot);
      await saveUserState();
      setSyncStatus("Restored local account cache");
    } else {
      applyState(createEmptyState());
      await saveUserState();
      setSyncStatus("New account ready");
    }

    writeStoredState(accountCacheKeyName);
  } catch (error) {
    applyState(accountSnapshot);
    setSyncStatus("Using local cache - sync failed");
    console.error("Plan Well sync failed", error);
  }
}

function authDisplayName() {
  if (isLocalPreview()) return "Local Preview";
  const meta = currentUser?.user_metadata || {};
  return meta.full_name || meta.name || currentUser?.email || "Account";
}

function userEmail() {
  if (isLocalPreview()) return "local-preview@localhost";
  return currentUser?.email || currentUser?.user_metadata?.email || "";
}

function setAuthVisibility() {
  const isConfigured = Boolean(supabaseClient) || isLocalPreview();
  const isAuth = Boolean(currentUser);
  
  if (window.isAuthPreviewActive) {
    ensureAuthScreen();
    bindAuthControls();
    const authScreen = document.querySelector("[data-auth-screen]");
    if (authScreen) {
      authScreen.style.setProperty("display", "grid", "important");
      authScreen.hidden = false;
      if (authScreen.querySelector("[data-auth-setup]")) {
        authScreen.querySelector("[data-auth-setup]").hidden = isConfigured;
      }
    }
    renderAccountControls();
    return;
  }

  document.body.classList.toggle("is-authenticated", isAuth || isLocalPreview());
  document.body.classList.toggle("is-logged-out", !isAuth && !isLocalPreview());
  document.body.classList.toggle("is-auth-unconfigured", !isConfigured && !isLocalPreview());
  document.body.classList.remove("is-auth-loading");

  const authScreen = document.querySelector("[data-auth-screen]");
  if (authScreen) {
    if (isLocalPreview() || isAuth) {
      authScreen.style.setProperty("display", "none", "important");
    } else {
      authScreen.style.removeProperty("display");
      authScreen.hidden = false;
    }
    if (authScreen.querySelector("[data-auth-setup]")) {
      authScreen.querySelector("[data-auth-setup]").hidden = isConfigured;
    }
    authScreen.querySelectorAll("[data-auth-google], [data-auth-submit], [data-auth-magic]").forEach((control) => {
      control.disabled = !isConfigured;
    });
  }

  renderAccountControls();
}

function startOfLocalDay(date = new Date()) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, amount) {
  const copy = startOfLocalDay(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function dateKey(date = new Date()) {
  return dateToValue(startOfLocalDay(date));
}

function todayKey() {
  return dateKey(new Date());
}

function dateForKey(key) {
  return dateFromValue(key) || startOfLocalDay(new Date());
}

function recentHabitDateKeys() {
  const today = startOfLocalDay(new Date());
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(today, -index)));
}

function selectedHabitDate() {
  const recent = recentHabitDateKeys();
  if (!recent.includes(selectedHabitDateKey)) selectedHabitDateKey = recent[0];
  return selectedHabitDateKey;
}

function isTodayKey(key) {
  return key === todayKey();
}

function isPastKey(key) {
  return key < todayKey();
}

function isEndOfDayWindow(now = new Date()) {
  return now.getHours() >= 21;
}

function reminderStorageKey(key = todayKey()) {
  return `goallab-end-day-dismissed-${key}`;
}

function formatHabitDay(key) {
  if (isTodayKey(key)) return "Today";
  if (key === dateKey(addDays(new Date(), -1))) return "Yesterday";
  return dateForKey(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatHabitButtonDay(key) {
  if (isTodayKey(key)) return "Today";
  if (key === dateKey(addDays(new Date(), -1))) return "Yesterday";
  return dateForKey(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function formatTodayReadout() {
  return new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function normalizeGoal(goal) {
  const steps = Array.isArray(goal?.steps)
    ? goal.steps.map(normalizeStep).filter((step) => step.text)
    : [];
  return {
    id: goal?.id || uid("goal"),
    title: String(goal?.title || "").trim() || "Untitled goal",
    category: String(goal?.category || DEFAULT_CATEGORIES[0]),
    deadline: String(goal?.deadline || ""),
    why: String(goal?.why || "").trim(),
    measure: String(goal?.measure || "").trim(),
    reward: String(goal?.reward || "").trim(),
    steps,
    complete: Boolean(goal?.complete)
  };
}

function normalizeStep(step) {
  const source = typeof step === "object" && step !== null ? step : { text: step };
  const target = Math.max(1, Math.min(30, Number(source.linkedHabitTarget || 7)));
  return {
    id: source.id || uid("step"),
    text: String(source.text || "").trim(),
    done: Boolean(source.done),
    routineIdea: String(source.routineIdea || "").trim(),
    linkedHabitId: String(source.linkedHabitId || ""),
    linkedAt: String(source.linkedAt || ""),
    linkedHabitTarget: target
  };
}

function normalizeHabit(habit) {
  const scheduleDays = normalizeScheduleDays(habit?.scheduleDays);
  const weeklyGoal = scheduleDays.length || Math.max(1, Math.min(7, Number(habit?.weeklyGoal || 7)));
  const checks = DAYS.map((_, index) => Boolean(habit?.checks?.[index]));
  const normalized = {
    id: habit?.id || uid("habit"),
    name: String(habit?.name || "").trim() || "Untitled habit",
    weeklyGoal,
    category: String(habit?.category || DEFAULT_CATEGORIES[0]),
    scheduleDays,
    supportedGoalId: String(habit?.supportedGoalId || ""),
    supportedStepId: String(habit?.supportedStepId || ""),
    checks,
    history: normalizeHabitHistory(habit?.history)
  };

  migrateWeeklyChecks(normalized, checks);
  return normalized;
}

function normalizeScheduleDays(value) {
  if (!Array.isArray(value)) return [...ALL_WEEKDAYS];
  const days = [...new Set(value.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day < DAYS.length)
    .sort((a, b) => a - b);
  return days.length ? days : [...ALL_WEEKDAYS];
}

function normalizeTask(task) {
  return {
    id: task?.id || uid("task"),
    title: String(task?.title || "").trim() || "Untitled task",
    subtext: String(task?.subtext || "").trim(),
    deadline: String(task?.deadline || ""),
    taskType: String(task?.taskType || (task?.linkedHabitId ? "habit" : "task")),
    linkedHabitId: String(task?.linkedHabitId || ""),
    supportedGoalId: String(task?.supportedGoalId || ""),
    supportedStepId: String(task?.supportedStepId || ""),
    done: Boolean(task?.done),
    createdAt: String(task?.createdAt || new Date().toISOString()),
    completedAt: String(task?.completedAt || "")
  };
}

function normalizeHabitHistory(history) {
  const normalized = {};
  if (!history || typeof history !== "object") return normalized;

  Object.entries(history).forEach(([key, record]) => {
    if (!dateFromValue(key)) return;
    const source = typeof record === "object" && record !== null ? record : { done: Boolean(record) };
    normalized[key] = {
      done: Boolean(source.done),
      reflection: String(source.reflection || ""),
      updatedAt: String(source.updatedAt || "")
    };
  });
  return normalized;
}

function migrateWeeklyChecks(habit, checks) {
  const mondayOffset = (new Date().getDay() + 6) % 7;
  const monday = addDays(new Date(), -mondayOffset);
  checks.forEach((done, index) => {
    if (!done) return;
    const key = dateKey(addDays(monday, index));
    if (!habit.history[key]) {
      habit.history[key] = { done: true, reflection: "", updatedAt: new Date().toISOString() };
    }
  });
}

function habitRecord(habit, key = selectedHabitDate()) {
  return habit.history?.[key] || { done: false, reflection: "", updatedAt: "" };
}

function ensureHabitRecord(habit, key = selectedHabitDate()) {
  if (!habit.history) habit.history = {};
  if (!habit.history[key]) habit.history[key] = { done: false, reflection: "", updatedAt: "" };
  return habit.history[key];
}

function habitDoneOn(habit, key = selectedHabitDate()) {
  return Boolean(habitRecord(habit, key).done);
}

function weekdayIndexForKey(key) {
  const day = dateForKey(key).getDay();
  return (day + 6) % 7;
}

function isHabitScheduledOn(habit, key = selectedHabitDate()) {
  const schedule = normalizeScheduleDays(habit.scheduleDays);
  return schedule.includes(weekdayIndexForKey(key));
}

function scheduledHabitsForDate(key = selectedHabitDate()) {
  return state.habits.filter((habit) => isHabitScheduledOn(habit, key));
}

function setHabitDone(habit, key, done) {
  const record = ensureHabitRecord(habit, key);
  record.done = done;
  record.updatedAt = new Date().toISOString();
}

function setHabitReflection(habit, key, reflection) {
  const record = ensureHabitRecord(habit, key);
  record.reflection = String(reflection || "").trim();
  record.updatedAt = new Date().toISOString();
}

function habitStreak(habit, fromKey = todayKey()) {
  let streak = 0;
  let cursor = dateForKey(fromKey);
  let guard = 0;
  while (!isHabitScheduledOn(habit, dateKey(cursor)) && guard < 370) {
    cursor = addDays(cursor, -1);
    guard += 1;
  }
  while (isHabitScheduledOn(habit, dateKey(cursor)) && habitDoneOn(habit, dateKey(cursor)) && guard < 740) {
    streak += 1;
    do {
      cursor = addDays(cursor, -1);
      guard += 1;
    } while (!isHabitScheduledOn(habit, dateKey(cursor)) && guard < 740);
  }
  return streak;
}

function habitDoneRecordCount() {
  return state.habits.reduce((sum, habit) => {
    return sum + Object.entries(habit.history || {}).filter(([key, record]) => {
      return record.done && isHabitScheduledOn(habit, key);
    }).length;
  }, 0);
}

function todayMissedHabits() {
  const key = todayKey();
  return scheduledHabitsForDate(key).filter((habit) => !habitDoneOn(habit, key));
}

function shouldShowReflection(key) {
  return isPastKey(key) || (isTodayKey(key) && isEndOfDayWindow());
}

function normalizeCategories(value, options = {}) {
  const source = Array.isArray(value) ? value : DEFAULT_CATEGORIES;
  const seen = new Set();
  const categories = source
    .map((category) => String(category || "").trim())
    .filter(Boolean)
    .filter((category) => {
      const key = category.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return categories.length || options.allowEmpty ? categories : [...DEFAULT_CATEGORIES];
}

function categoryList() {
  state.categories = normalizeCategories(state.categories, { allowEmpty: true });
  return state.categories;
}

function fallbackCategory() {
  return categoryList()[0] || "Uncategorized";
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 10000)}`;
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = value;
  });
}

function setBar(name, value) {
  document.querySelectorAll(`[data-bar="${name}"]`).forEach((element) => {
    element.style.width = `${Math.max(0, Math.min(100, value))}%`;
  });
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function setCommandRing(name, value) {
  const percent = clampPercent(value);
  document.querySelectorAll(`[data-command-ring="${name}"]`).forEach((element) => {
    element.style.setProperty("--metric-angle", `${percent * 3.6}deg`);
  });
}

function setCommandCells(name, value) {
  const percent = clampPercent(value);
  document.querySelectorAll(`[data-command-grid="${name}"]`).forEach((element) => {
    const cells = [...element.querySelectorAll("span")];
    const activeCount = percent > 0 ? Math.max(1, Math.round((percent / 100) * cells.length)) : 0;
    cells.forEach((cell, index) => {
      cell.classList.toggle("is-active", index < activeCount);
    });
  });
}

function setCommandTower(name, activeCount) {
  document.querySelectorAll(`[data-command-tower="${name}"]`).forEach((element) => {
    const levels = [...element.querySelectorAll("span")];
    levels.forEach((level, index) => {
      level.classList.toggle("is-active", index < activeCount);
    });
  });
}

function syncCommandVisuals(data) {
  setCommandRing("overallProgress", data.overallProgress);
  setCommandRing("goalCompletion", data.averageGoalProgress);
  setCommandRing("habitScore", data.habitScore);
  setCommandCells("habitScore", data.habitScore);

  const streakLevels = Math.min(4, data.bestHabit.streak);
  const stepProgress = data.totalSteps ? Math.ceil((data.stepsDone / data.totalSteps) * 4) : 0;
  setCommandTower("bestStreak", streakLevels);
  setCommandTower("stepsFinished", stepProgress);
}

function goalProgress(goal) {
  if (!goal.steps.length) return goal.complete ? 100 : 0;
  const complete = goal.steps.filter((step) => step.done).length;
  return Math.round((complete / goal.steps.length) * 100);
}

function daysLeft(deadline) {
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${deadline}T00:00:00`);
  return Math.ceil((due - today) / 86400000);
}

function totals() {
  const goalCount = state.goals.length;
  const taskCount = state.tasks.length;
  const tasksDone = state.tasks.filter((task) => task.done).length;
  const linkedTasks = state.tasks.filter((task) => task.linkedHabitId && findHabitById(task.linkedHabitId)).length;
  const openTasks = Math.max(0, taskCount - tasksDone);
  const goalProgressValues = state.goals.map(goalProgress);
  const achievedGoals = goalProgressValues.filter((progress) => progress === 100).length;
  const averageGoalProgress = goalCount
    ? Math.round(goalProgressValues.reduce((sum, value) => sum + value, 0) / goalCount)
    : 0;
  const totalSteps = state.goals.reduce((sum, goal) => sum + goal.steps.length, 0);
  const stepsDone = state.goals.reduce((sum, goal) => sum + goal.steps.filter((step) => step.done).length, 0);
  const today = todayKey();
  const scheduledToday = scheduledHabitsForDate(today);
  const plannedChecks = scheduledToday.length;
  const checksDone = scheduledToday.filter((habit) => habitDoneOn(habit, today)).length;
  const missedToday = Math.max(0, plannedChecks - checksDone);
  const totalHabitCompletions = habitDoneRecordCount();
  const habitScore = plannedChecks ? Math.round((checksDone / plannedChecks) * 100) : 0;
  const overallProgress = goalCount || plannedChecks
    ? Math.round((averageGoalProgress + habitScore) / ((goalCount ? 1 : 0) + (plannedChecks ? 1 : 0)))
    : 0;
  const dueSoon = state.goals.filter((goal) => {
    const left = daysLeft(goal.deadline);
    return left !== null && left >= 0 && left <= 7 && goalProgress(goal) < 100;
  }).length;
  const bestHabit = state.habits
    .map((habit) => ({ name: habit.name, streak: habitStreak(habit) }))
    .sort((a, b) => b.streak - a.streak)[0] || { name: "No habits yet", streak: 0 };
  const strongestHabit = bestHabit.streak > 0 ? bestHabit.name : "None";
  const completed21DayHabits = state.habits.filter((h) => habitStreak(h) >= 21).length;
  const xp = totalHabitCompletions * 10 + stepsDone * 40 + achievedGoals * 300 + tasksDone * 15 + completed21DayHabits * 500;

  return {
    achievedGoals,
    averageGoalProgress,
    bestHabit,
    checksDone,
    dueSoon,
    goalCount,
    habitCount: state.habits.length,
    habitScore,
    missedToday,
    overallProgress,
    plannedChecks,
    stepsDone,
    taskCount,
    tasksDone,
    linkedTasks,
    openTasks,
    totalSteps,
    totalHabitCompletions,
    strongestHabit,
    xp
  };
}

function syncMetrics() {
  const data = totals();
  const level = Math.floor(data.xp / 1000) + 1;

  setText('[data-profile-level]', `Level ${level}`);
  setText('[data-profile-xp]', `${data.xp} XP`);
  setText('[data-metric="overallProgress"]', `${data.overallProgress}%`);
  setText('[data-metric="goalCompletion"]', `${data.averageGoalProgress}%`);
  setText('[data-metric="goalsAchieved"]', `${data.achievedGoals} / ${data.goalCount}`);
  setText('[data-metric="activeGoals"]', data.goalCount);
  setText('[data-metric="dueSoon"]', data.dueSoon);
  setText('[data-metric="stepsFinished"]', `${data.stepsDone} / ${data.totalSteps}`);
  setText('[data-metric="stepsFinishedShort"]', data.stepsDone);
  setText('[data-metric="habitScore"]', `${data.habitScore}%`);
  setText('[data-metric="checksCompleted"]', data.checksDone);
  setText('[data-metric="missedToday"]', data.missedToday);
  setText('[data-metric="habitCount"]', data.habitCount);
  setText('[data-metric="taskCount"]', data.taskCount);
  setText('[data-metric="tasksDone"]', data.tasksDone);
  setText('[data-metric="linkedTasks"]', data.linkedTasks);
  setText('[data-metric="openTasks"]', data.openTasks);
  setText('[data-metric="bestStreak"]', `${data.bestHabit.streak} days`);
  setText('[data-metric="strongestHabit"]', data.strongestHabit);
  setText('[data-metric="strongestStreak"]', `${data.bestHabit.streak} day streak`);
  setText('[data-copy="strongestStreak"]', `${data.bestHabit.streak} day streak`);
  setText('[data-metric="recoveryHabit"]', data.habitCount ? findRecoveryHabit() : "None");
  setText('[data-metric="weeklyChecks"]', `${data.checksDone} / ${data.plannedChecks} scheduled habits done today`);
  setText('[data-metric="rewardProgress"]', `${data.xp} XP earned`);
  setText('[data-metric="weeklyXp"]', data.xp);
  setText('[data-metric="nextUnlock"]', `${Math.min(100, Math.round((data.xp / 300) * 100))}%`);
  syncDashboardSummary(data);

  setText('[data-copy="goalLeft"]', data.goalCount ? `${data.goalCount - data.achievedGoals} still in motion` : "No goals yet");
  setText('[data-copy="habitChecks"]', `${data.checksDone} done today`);
  setText('[data-copy="goalAreas"]', `Across ${new Set(state.goals.map((goal) => goal.category)).size} life areas`);
  setText('[data-copy="habitPlanned"]', `Out of ${data.plannedChecks} scheduled today`);
  setText('[data-copy="bestHabit"]', data.bestHabit.streak > 0 ? data.bestHabit.name : "No habits yet");

  setBar("overallProgress", data.overallProgress);
  setBar("goalCompletion", data.averageGoalProgress);
  setBar("habitScore", data.habitScore);
  setBar("nextUnlock", Math.min(100, Math.round((data.xp / 300) * 100)));
  syncCommandVisuals(data);
}

function syncDashboardSummary(data) {
  const topGoal = state.goals.find((goal) => goalProgress(goal) < 100) || state.goals[0];
  const nextTask = state.tasks.find((task) => !task.done) || state.tasks[0];
  const unlockProgress = Math.min(100, Math.round((data.xp / 300) * 100));

  setText("[data-summary-top-goal]", topGoal ? topGoal.title : "No goals yet");
  setText("[data-summary-goal-note]", topGoal ? goalSummaryNote(topGoal) : "Waiting for your first goal");
  setText("[data-summary-habit-note]", data.habitCount ? `${data.checksDone} / ${data.plannedChecks} done today` : "No habits yet");
  setText("[data-summary-next-task]", nextTask ? nextTask.title : "No tasks yet");
  setText("[data-summary-task-note]", nextTask ? taskSummaryNote(nextTask) : "Add one-off work here");
  setText("[data-summary-reward-status]", data.xp ? `${unlockProgress}% toward next unlock` : "No XP yet");
}

function taskSummaryNote(task) {
  if (task.done) return "Finished";
  const habit = findHabitById(task.linkedHabitId);
  return habit ? `Linked to ${habit.name}` : "Not linked to a habit";
}

function goalSummaryNote(goal) {
  const progress = goalProgress(goal);
  const left = daysLeft(goal.deadline);
  const due = left === null ? "No deadline" : left < 0 ? "Overdue" : left === 0 ? "Due today" : `${left} days left`;
  return `${goal.category} | ${progress}% | ${due}`;
}

function findRecoveryHabit() {
  return todayMissedHabits()[0]?.name || "None";
}

function routineEditKey(goalId, stepId) {
  return `${goalId}:${stepId}`;
}

function reflectionEditKey(habitId, key) {
  return `${habitId}:${key}`;
}

function findHabitById(id) {
  return state.habits.find((habit) => habit.id === id);
}

function findGoalStep(goalId, stepId) {
  const goal = state.goals.find((item) => item.id === goalId);
  const step = goal?.steps.find((item) => item.id === stepId);
  return { goal, step };
}

function goalStepOptions() {
  return state.goals.flatMap((goal) =>
    goal.steps.map((step, index) => ({
      goal,
      step,
      index,
      value: `${goal.id}:${step.id}`,
      label: `${goal.title} - Step ${index + 1}: ${step.text}`
    }))
  );
}

function parseGoalStepValue(value) {
  const [goalId = "", stepId = ""] = String(value || "").split(":");
  const { goal, step } = findGoalStep(goalId, stepId);
  return goal && step ? { goalId: goal.id, stepId: step.id } : { goalId: "", stepId: "" };
}

function supportingHabitsForStep(goal, step) {
  const matches = state.habits.filter((habit) => {
    return habit.supportedGoalId === goal.id && habit.supportedStepId === step.id;
  });
  if (step.linkedHabitId) {
    const legacyHabit = findHabitById(step.linkedHabitId);
    if (legacyHabit && !matches.some((habit) => habit.id === legacyHabit.id)) matches.push(legacyHabit);
  }
  return matches;
}

function supportingTasksForStep(goal, step) {
  return state.tasks.filter((task) => task.supportedGoalId === goal.id && task.supportedStepId === step.id);
}

function makeHabit(name, category, scheduleDays = ALL_WEEKDAYS, supportedGoalId = "", supportedStepId = "") {
  return {
    id: uid("habit"),
    name: String(name || "").trim() || "Untitled habit",
    scheduleDays: normalizeScheduleDays(scheduleDays),
    weeklyGoal: normalizeScheduleDays(scheduleDays).length,
    category: String(category || fallbackCategory()),
    supportedGoalId: String(supportedGoalId || ""),
    supportedStepId: String(supportedStepId || ""),
    checks: [false, false, false, false, false, false, false],
    history: {}
  };
}

function makeTask(
  title,
  subtext,
  linkedHabitId = "",
  deadline = "",
  supportedGoalId = "",
  supportedStepId = "",
  taskType = "task"
) {
  const habit = findHabitById(linkedHabitId);
  const support = parseGoalStepValue(supportedGoalId && supportedStepId ? `${supportedGoalId}:${supportedStepId}` : "");
  const date = dateFromValue(deadline);
  return {
    id: uid("task"),
    title: String(title || "").trim() || "Untitled task",
    subtext: String(subtext || "").trim(),
    deadline: date ? dateToValue(date) : "",
    taskType: taskType === "habit" ? "habit" : "task",
    linkedHabitId: habit ? habit.id : "",
    supportedGoalId: support.goalId,
    supportedStepId: support.stepId,
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: ""
  };
}

function tasksForHabit(habitId, key = selectedHabitDate()) {
  return state.tasks.filter((task) => task.linkedHabitId === habitId && task.deadline === key);
}

function taskHabitOptionsMarkup(selectedId = "") {
  return `
    <option value="">No linked habit</option>
    ${state.habits.map((habit) => `
      <option value="${escapeHtml(habit.id)}" ${habit.id === selectedId ? "selected" : ""}>${escapeHtml(habit.name)}</option>
    `).join("")}
  `;
}

function categoryOptionsMarkup(selected = fallbackCategory()) {
  const categories = categoryList();
  const formCategories = categories.length ? categories : [fallbackCategory()];
  const selectedCategory = formCategories.includes(selected) ? selected : fallbackCategory();
  return formCategories.map((category) => `
    <option value="${escapeHtml(category)}" ${category === selectedCategory ? "selected" : ""}>${escapeHtml(category)}</option>
  `).join("");
}

function scheduleDayChoicesMarkup(selectedDays = ALL_WEEKDAYS) {
  const selected = normalizeScheduleDays(selectedDays);
  return DAYS.map((day, index) => `
    <button class="weekday-choice ${selected.includes(index) ? "is-selected" : ""}" type="button" data-edit-weekday="${index}" aria-pressed="${selected.includes(index)}">
      ${day}
    </button>
  `).join("");
}

function goalStepSelectMarkup(selectedGoalId = "", selectedStepId = "") {
  const selected = selectedGoalId && selectedStepId ? `${selectedGoalId}:${selectedStepId}` : "";
  return `
    <option value="">No goal step selected</option>
    ${goalStepOptions().map((option) => `
      <option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>
    `).join("")}
  `;
}

function taskTypeOptionsMarkup(selected = "task") {
  const value = selected === "habit" ? "habit" : "task";
  return `
    <option value="task" ${value === "task" ? "selected" : ""}>One-off task</option>
    <option value="habit" ${value === "habit" ? "selected" : ""}>Habit-linked task</option>
  `;
}

function deadlineFieldMarkup({ id, value = "", required = false, label = "Deadline" }) {
  return `
    <div class="form-field date-field deadline-date-field ${required ? "is-required-date" : ""}" data-date-field ${required ? "data-required-date" : ""}>
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <button class="date-trigger" type="button" data-date-trigger aria-haspopup="dialog" aria-expanded="false" aria-describedby="${escapeHtml(id)}-hint">
        <span class="date-value" data-date-value id="${escapeHtml(id)}-hint">Pick a deadline</span>
        <span class="date-icon" aria-hidden="true"></span>
      </button>
      <input id="${escapeHtml(id)}" name="deadline" type="hidden" value="${escapeHtml(value)}" data-date-input>
      <div class="date-popover" data-date-popover hidden role="dialog" aria-label="Choose ${escapeHtml(label.toLowerCase())}"></div>
    </div>
  `;
}

function createHabitFromRoutine(stepText, category) {
  const habit = makeHabit(stepText, category);
  state.habits.push(habit);
  return habit;
}

function linkStepToHabit(step, habitId) {
  step.linkedHabitId = habitId;
  step.linkedAt = step.linkedAt || new Date().toISOString();
  step.linkedHabitTarget = step.linkedHabitTarget || 7;
}

function unlinkStepRoutine(step) {
  step.linkedHabitId = "";
  step.linkedAt = "";
  step.linkedHabitTarget = 7;
}

function routineProgress(habit, target = 7) {
  const keys = [];
  let cursor = dateForKey(todayKey());
  let guard = 0;
  while (keys.length < target && guard < 90) {
    const key = dateKey(cursor);
    if (isHabitScheduledOn(habit, key)) keys.push(key);
    cursor = addDays(cursor, -1);
    guard += 1;
  }
  return keys.filter((key) => habitDoneOn(habit, key)).length;
}

function habitLinkHref() {
  return document.body.dataset.page === "dashboard" ? "#habits-section" : "habits.html";
}

function taskLinkHref() {
  return document.body.dataset.page === "dashboard" ? "#tasks-section" : "tasks.html";
}

function habitOptionsMarkup(selectedId = "") {
  if (!state.habits.length) return `<option value="">No habits yet</option>`;
  return `
    <option value="">Choose a habit</option>
    ${state.habits.map((habit) => `
      <option value="${escapeHtml(habit.id)}" ${habit.id === selectedId ? "selected" : ""}>${escapeHtml(habit.name)}</option>
    `).join("")}
  `;
}

function renderGoals() {
  document.querySelectorAll("[data-goal-list]").forEach((list) => {
    const limit = list.dataset.goalList === "dashboard" ? 3 : state.goals.length;
    list.innerHTML = "";
    state.goals.slice(0, limit).forEach((goal, index) => {
      list.append(goalRow(goal, index));
    });
  });

  toggleEmpty("dashboardGoals", state.goals.length === 0);
  toggleEmpty("goalsPage", state.goals.length === 0);
  renderTinyWins();
}

function goalRow(goal, index) {
  const row = document.createElement("div");
  row.className = "goal-row wide";
  if (editingGoalId === goal.id) {
    row.classList.add("is-editing-item");
    row.innerHTML = goalEditMarkup(goal);
    bindGoalEditControls(row, goal);
    return row;
  }
  const progress = goalProgress(goal);
  const left = daysLeft(goal.deadline);
  const leftLabel = left === null ? "No deadline" : left < 0 ? "Overdue" : `${left} days left`;
  row.innerHTML = `
    <div class="goal-icon ${categoryClass(goal.category)}">${String(index + 1).padStart(2, "0")}</div>
    <div class="goal-copy">
      <strong>${escapeHtml(goal.title)}</strong>
      <span>${escapeHtml(goal.category)}${goal.deadline ? ` | deadline: ${formatDate(goal.deadline)}` : ""}</span>
      <div class="progress-track"><span style="width: ${progress}%"></span></div>
      ${goal.why ? `<small>Why: ${escapeHtml(goal.why)}</small>` : ""}
      ${goal.measure ? `<small>Success: ${escapeHtml(goal.measure)}</small>` : ""}
      ${goal.reward ? `<small>Reward: ${escapeHtml(goal.reward)}</small>` : ""}
      ${stepsMarkup(goal)}
    </div>
    <div class="goal-meta">
      <strong>${progress}%</strong>
      <span>${leftLabel}</span>
      <button class="ghost-button edit-item-button" type="button" data-edit-goal="${goal.id}">Edit</button>
      <button class="delete-button" type="button" data-delete-goal="${goal.id}">Delete</button>
    </div>
  `;
  row.querySelector("[data-edit-goal]")?.addEventListener("click", () => {
    editingGoalId = goal.id;
    render();
  });
  row.querySelectorAll("[data-step]").forEach((input) => {
    input.addEventListener("change", () => {
      const step = goal.steps.find((item) => item.id === input.dataset.step);
      if (step) step.done = input.checked;
      saveAndRender();
    });
  });
  row.querySelectorAll("[data-start-routine-link]").forEach((button) => {
    button.addEventListener("click", () => {
      editingRoutineLinkKey = routineEditKey(goal.id, button.dataset.startRoutineLink);
      render();
    });
  });
  row.querySelectorAll("[data-cancel-routine-link]").forEach((button) => {
    button.addEventListener("click", () => {
      editingRoutineLinkKey = "";
      render();
    });
  });
  row.querySelectorAll("[data-unlink-routine]").forEach((button) => {
    button.addEventListener("click", () => {
      const { step } = findGoalStep(goal.id, button.dataset.unlinkRoutine);
      if (step) unlinkStepRoutine(step);
      editingRoutineLinkKey = "";
      saveAndRender();
    });
  });
  row.querySelectorAll("[data-save-routine-link]").forEach((button) => {
    button.addEventListener("click", () => {
      const { step } = findGoalStep(goal.id, button.dataset.saveRoutineLink);
      const picker = row.querySelector(`[data-routine-picker="${button.dataset.saveRoutineLink}"]`);
      const habit = findHabitById(picker?.value);
      if (step && habit) {
        linkStepToHabit(step, habit.id);
        editingRoutineLinkKey = "";
        saveAndRender();
      }
    });
  });
  row.querySelectorAll("[data-create-routine-link]").forEach((button) => {
    button.addEventListener("click", () => {
      const { goal: matchGoal, step } = findGoalStep(goal.id, button.dataset.createRoutineLink);
      if (matchGoal && step) {
        const habit = createHabitFromRoutine(step.text, matchGoal.category);
        linkStepToHabit(step, habit.id);
        editingRoutineLinkKey = "";
        saveAndRender();
      }
    });
  });
  row.querySelectorAll("[data-routine-habit-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href?.startsWith("#")) return;
      event.preventDefault();
      scrollToHashSection(href, link);
    });
  });
  row.querySelector("[data-delete-goal]").addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete goal?",
      copy: `This will delete "${goal.title}" and its micro steps. Linked habits will stay in your habit tracker.`,
      confirmLabel: "Delete goal",
      onConfirm: () => {
        state.goals = state.goals.filter((item) => item.id !== goal.id);
        saveAndRender();
      }
    });
  });
  return row;
}

function goalEditMarkup(goal) {
  return `
    <form class="edit-card-form goal-edit-form" data-goal-edit-form="${goal.id}">
      <div class="edit-form-heading">
        <div>
          <p class="eyebrow">Edit goal</p>
          <h3>${escapeHtml(goal.title)}</h3>
        </div>
        <div class="edit-form-actions">
          <button class="text-button" type="submit">Save</button>
          <button class="ghost-button" type="button" data-cancel-goal-edit>Cancel</button>
          <button class="delete-button" type="button" data-delete-goal="${goal.id}">Delete</button>
        </div>
      </div>
      <label>
        Goal name
        <input name="title" type="text" value="${escapeHtml(goal.title)}" required>
      </label>
      <label>
        Area of life
        <select name="category" required>${categoryOptionsMarkup(goal.category)}</select>
      </label>
      ${deadlineFieldMarkup({ id: `goal-edit-deadline-${goal.id}`, value: goal.deadline })}
      <label>
        Why this matters
        <textarea name="why" rows="2">${escapeHtml(goal.why)}</textarea>
      </label>
      <label>
        Measure success
        <input name="measure" type="text" value="${escapeHtml(goal.measure)}">
      </label>
      <label>
        Reward
        <input name="reward" type="text" value="${escapeHtml(goal.reward)}">
      </label>
      <div class="edit-micro-steps">
        <div class="micro-step-builder-head">
          <div>
            <strong>Micro steps</strong>
            <span>Edit milestones and the routine idea that supports each one.</span>
          </div>
          <button class="ghost-button" type="button" data-add-edit-step>Add step</button>
        </div>
        <div class="edit-step-list" data-edit-step-list>
          ${goal.steps.map((step, stepIndex) => editStepMarkup(step, stepIndex)).join("") || editStepMarkup(normalizeStep({ text: "" }), 0)}
        </div>
      </div>
    </form>
  `;
}

function editStepMarkup(step, index) {
  return `
    <div class="micro-step-builder-row" data-edit-step-row data-step-id="${escapeHtml(step.id || "")}">
      <div class="micro-step-builder-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
      <label>
        Step ${index + 1}
        <input type="text" data-edit-step-text value="${escapeHtml(step.text || "")}" placeholder="Milestone">
      </label>
      <label>
        Daily routine that supports it
        <textarea data-edit-step-routine rows="2" placeholder="Example: Practice for 30 minutes after school.">${escapeHtml(step.routineIdea || "")}</textarea>
      </label>
      <label class="edit-step-done">
        Done
        <input type="checkbox" data-edit-step-done ${step.done ? "checked" : ""}>
      </label>
      <button class="ghost-button micro-step-remove" type="button" data-remove-edit-step>Remove</button>
    </div>
  `;
}

function bindGoalEditControls(row, goal) {
  const form = row.querySelector("[data-goal-edit-form]");
  const list = row.querySelector("[data-edit-step-list]");
  const refresh = () => {
    list?.querySelectorAll("[data-edit-step-row]").forEach((stepRow, index) => {
      stepRow.querySelector(".micro-step-builder-index").textContent = String(index + 1).padStart(2, "0");
      const label = stepRow.querySelector("label:first-of-type");
      if (label) label.firstChild.textContent = `Step ${index + 1}`;
    });
  };
  row.querySelector("[data-add-edit-step]")?.addEventListener("click", () => {
    list?.insertAdjacentHTML("beforeend", editStepMarkup(normalizeStep({ text: "" }), list.querySelectorAll("[data-edit-step-row]").length));
    refresh();
  });
  row.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-edit-step]");
    if (!remove) return;
    const stepRow = remove.closest("[data-edit-step-row]");
    const rows = list ? [...list.querySelectorAll("[data-edit-step-row]")] : [];
    if (rows.length <= 1) {
      stepRow.querySelector("[data-edit-step-text]").value = "";
      stepRow.querySelector("[data-edit-step-routine]").value = "";
      stepRow.querySelector("[data-edit-step-done]").checked = false;
    } else {
      stepRow.remove();
    }
    refresh();
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    goal.title = String(data.get("title") || "").trim() || goal.title;
    goal.category = String(data.get("category") || fallbackCategory());
    goal.deadline = String(data.get("deadline") || "");
    goal.why = String(data.get("why") || "").trim();
    goal.measure = String(data.get("measure") || "").trim();
    goal.reward = String(data.get("reward") || "").trim();
    goal.steps = [...form.querySelectorAll("[data-edit-step-row]")]
      .map((stepRow) => normalizeStep({
        id: stepRow.dataset.stepId || uid("step"),
        text: stepRow.querySelector("[data-edit-step-text]")?.value,
        routineIdea: stepRow.querySelector("[data-edit-step-routine]")?.value,
        done: stepRow.querySelector("[data-edit-step-done]")?.checked,
        linkedHabitTarget: 7
      }))
      .filter((step) => step.text);
    editingGoalId = "";
    saveAndRender();
  });
  row.querySelector("[data-cancel-goal-edit]")?.addEventListener("click", () => {
    editingGoalId = "";
    render();
  });
  row.querySelector("[data-delete-goal]")?.addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete goal?",
      copy: `This will delete "${goal.title}" and its micro steps. Linked habits will stay in your habit tracker.`,
      confirmLabel: "Delete goal",
      onConfirm: () => {
        state.goals = state.goals.filter((item) => item.id !== goal.id);
        editingGoalId = "";
        saveAndRender();
      }
    });
  });
}

function stepsMarkup(goal) {
  if (!goal.steps.length) return "";
  const completed = goal.steps.filter((step) => step.done).length;
  const activeStep = goal.steps.find((step) => !step.done);
  return `
    <div class="step-list">
      <div class="micro-step-summary">
        <strong>Micro steps</strong>
        <span>${completed} / ${goal.steps.length} steps complete</span>
      </div>
      ${goal.steps.map((step, index) => `
        <div class="micro-step-item ${step.done ? "is-complete" : ""} ${activeStep?.id === step.id ? "is-active-step" : ""}">
          <div class="micro-step-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
          <label class="step-check">
            <input type="checkbox" data-step="${step.id}" ${step.done ? "checked" : ""}>
            <span>${escapeHtml(step.text)}</span>
          </label>
          ${activeStep?.id === step.id ? `<span class="active-step-pill">Active step</span>` : ""}
          ${step.routineIdea ? `<div class="routine-idea-note"><span>Routine to build</span><strong>${escapeHtml(step.routineIdea)}</strong></div>` : ""}
          ${routineStepMarkup(goal, step)}
        </div>
      `).join("")}
    </div>
  `;
}

function routineStepMarkup(goal, step) {
  const supportHabits = supportingHabitsForStep(goal, step);
  const supportTasks = supportingTasksForStep(goal, step);
  if (!supportHabits.length && !supportTasks.length) {
    return `
      <div class="routine-link-status is-unlinked">
        <span>No habit or task supports this step yet.</span>
        <div class="routine-link-actions">
          <a class="ghost-button link-button" href="${habitLinkHref()}" data-routine-habit-link>Go to habits</a>
        </div>
      </div>
    `;
  }

  return `
    <div class="routine-link-status is-linked">
      <div>
        ${supportHabits.length ? `<span>Supporting habits</span>` : ""}
        ${supportHabits.map((habit) => {
          const target = step.linkedHabitTarget || 7;
          const doneCount = routineProgress(habit, target);
          const scheduledToday = isHabitScheduledOn(habit, todayKey());
          const doneToday = habitDoneOn(habit, todayKey());
          const todayStatus = !scheduledToday ? "Not scheduled today" : doneToday ? "Done today" : "Open today";
          return `<strong>${escapeHtml(habit.name)} - ${todayStatus} | ${doneCount} / ${target} routine checks</strong>`;
        }).join("")}
        ${supportTasks.length ? `<span>Supporting tasks</span>` : ""}
        ${supportTasks.map((task) => `
          <strong>${task.done ? "Cleared" : "Open"} - ${escapeHtml(task.title)}${task.deadline ? ` | ${escapeHtml(taskDeadlineLabel(task))}` : ""}</strong>
        `).join("")}
      </div>
      <div class="routine-link-actions">
        <a class="ghost-button link-button" href="${habitLinkHref()}" data-routine-habit-link>Go to habits</a>
        <a class="ghost-button link-button" href="${taskLinkHref()}" data-routine-task-link>Go to tasks</a>
      </div>
    </div>
  `;
}

function renderTinyWins() {
  const target = document.querySelector("[data-tiny-wins]");
  if (!target) return;
  target.innerHTML = "";
  const pending = state.goals.flatMap((goal) =>
    goal.steps.filter((step) => !step.done).slice(0, 1).map((step) => ({ goal, step }))
  ).slice(0, 4);
  pending.forEach(({ goal, step }) => {
    const label = document.createElement("label");
    label.className = "task-item";
    label.innerHTML = `<input type="checkbox" data-tiny-step="${step.id}" data-goal-id="${goal.id}"> ${escapeHtml(step.text)}`;
    label.querySelector("input").addEventListener("change", (event) => {
      const matchGoal = state.goals.find((item) => item.id === event.target.dataset.goalId);
      const matchStep = matchGoal?.steps.find((item) => item.id === event.target.dataset.tinyStep);
      if (matchStep) matchStep.done = event.target.checked;
      saveAndRender();
    });
    target.append(label);
  });
  toggleEmpty("tinyWins", pending.length === 0);
}

function renderCategories() {
  const categories = categoryList();
  document.querySelectorAll("[data-category-list]").forEach((categoryList) => {
    categoryList.innerHTML = "";
    categories.forEach((category) => {
      const goals = state.goals.filter((goal) => goal.category === category);
      const achieved = goals.filter((goal) => goalProgress(goal) === 100).length;
      const percent = goals.length ? Math.round((achieved / goals.length) * 100) : 0;
      const row = document.createElement("div");
      row.className = "category-row";
      if (editingCategoryName === category) {
        row.classList.add("is-editing");
        row.innerHTML = categoryEditMarkup(category);
        bindCategoryEditControls(row, category);
      } else {
        row.innerHTML = `
          <button class="category-progress-trigger" type="button" data-edit-category="${escapeHtml(category)}" aria-label="Edit ${escapeHtml(category)}">
            <span class="category-progress-name">${escapeHtml(category)}</span>
            <div class="progress-track"><span style="width: ${percent}%"></span></div>
            <strong class="category-progress-value">${percent}% complete</strong>
            <span class="category-hover-label" aria-hidden="true">Edit</span>
          </button>
        `;
        row.querySelector("[data-edit-category]").addEventListener("click", () => {
          editingCategoryName = category;
          render();
        });
      }
      categoryList.append(row);
    });
  });

  const lifeGrid = document.querySelector("[data-life-grid]");
  if (lifeGrid) {
    lifeGrid.innerHTML = "";
    categories.forEach((category) => {
      const goals = state.goals.filter((goal) => goal.category === category);
      const achieved = goals.filter((goal) => goalProgress(goal) === 100).length;
      const tile = document.createElement("div");
      tile.className = "life-tile";
      if (editingCategoryName === category) {
        tile.classList.add("is-editing");
        tile.innerHTML = categoryEditMarkup(category);
        bindCategoryEditControls(tile, category);
      } else {
        tile.innerHTML = `
          <button class="life-tile-trigger" type="button" data-edit-category="${escapeHtml(category)}" aria-label="Edit ${escapeHtml(category)}">
            <strong>${escapeHtml(category)}</strong>
            <span>${achieved} / ${goals.length}</span>
            <em class="category-hover-label" aria-hidden="true">Edit</em>
          </button>
        `;
        tile.querySelector("[data-edit-category]").addEventListener("click", () => {
          editingCategoryName = category;
          render();
        });
      }
      lifeGrid.append(tile);
    });
  }

  renderCategoryManager();
  renderGoalSignalMaps(categories);
}

function categoryEditMarkup(category) {
  return `
    <label class="category-rename-field">
      Rename area
      <input type="text" value="${escapeHtml(category)}" data-rename-category-input="${escapeHtml(category)}">
    </label>
    <div class="category-actions">
      <button class="ghost-button" type="button" data-save-category="${escapeHtml(category)}">Save</button>
      <button class="ghost-button" type="button" data-cancel-category-edit>Cancel</button>
      <button class="delete-button category-remove-button" type="button" data-remove-category="${escapeHtml(category)}">Delete</button>
    </div>
  `;
}

function bindCategoryEditControls(container, category) {
  const input = container.querySelector("[data-rename-category-input]");
  container.querySelector("[data-save-category]")?.addEventListener("click", () => {
    renameCategory(category, input.value);
  });
  container.querySelector("[data-cancel-category-edit]")?.addEventListener("click", () => {
    editingCategoryName = "";
    render();
  });
  container.querySelector("[data-remove-category]")?.addEventListener("click", () => {
    openCategoryRemoveConfirm(category);
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") renameCategory(category, input.value);
    if (event.key === "Escape") {
      editingCategoryName = "";
      render();
    }
  });
  window.setTimeout(() => {
    input?.focus();
    input?.select();
  }, 0);
}

function renderGoalSignalMaps(categories = categoryList()) {
  document.querySelectorAll("[data-goal-signal-map]").forEach((map) => {
    const total = categories.length || 1;
    map.dataset.density = total > 6 ? "dense" : "calm";
    map.innerHTML = `
      <span class="signal-orbit orbit-one"></span>
      <span class="signal-orbit orbit-two"></span>
      <span class="signal-core"></span>
      ${categories.map((category, index) => {
        const angle = -150 + (300 / Math.max(1, total - 1)) * index;
        const radius = total > 6 ? 38 : 44;
        const radians = angle * Math.PI / 180;
        const x = 50 + Math.cos(radians) * radius;
        const y = 52 + Math.sin(radians) * (radius * 0.56);
        const progress = state.goals.filter((goal) => goal.category === category && goalProgress(goal) === 100).length;
        const active = state.goals.filter((goal) => goal.category === category).length;
        return `
          <span class="signal-node" style="--node-x: ${x.toFixed(2)}%; --node-y: ${y.toFixed(2)}%; --node-z: ${18 + (index % 3) * 12}px; --node-float-z: ${28 + (index % 3) * 12}px; --node-delay: ${(index % 3) * -0.8}s;">
            <i></i>
            <b>${escapeHtml(category)}</b>
            <em>${progress}/${active}</em>
          </span>
        `;
      }).join("")}
    `;
  });
}

function renderCategoryOptions() {
  const categories = categoryList();
  const formCategories = categories.length ? categories : [fallbackCategory()];
  document.querySelectorAll('select[name="category"]').forEach((select) => {
    const previous = select.value;
    select.innerHTML = formCategories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");
    select.value = formCategories.includes(previous) ? previous : fallbackCategory();
  });
  renderCategoryPickers(formCategories);
}

function renderCategoryPickers(categories = categoryList()) {
  document.querySelectorAll("[data-category-picker]").forEach((picker) => {
    const label = picker.closest("label");
    const select = label?.querySelector('select[name="category"]');
    if (!select) return;
    picker.innerHTML = "";
    categories.forEach((category) => {
      const button = document.createElement("button");
      button.className = "category-choice";
      button.type = "button";
      button.textContent = category;
      button.dataset.categoryChoice = category;
      button.setAttribute("aria-pressed", String(select.value === category));
      button.addEventListener("click", () => {
        select.value = category;
        picker.querySelectorAll("[data-category-choice]").forEach((choice) => {
          choice.classList.toggle("is-selected", choice.dataset.categoryChoice === category);
          choice.setAttribute("aria-pressed", String(choice.dataset.categoryChoice === category));
        });
      });
      button.classList.toggle("is-selected", select.value === category);
      picker.append(button);
    });
  });
}

function renderCategoryManager() {
  const categories = categoryList();
  document.querySelectorAll("[data-category-manager]").forEach((manager) => {
    manager.innerHTML = "";
    categories.forEach((category) => {
      const goalCount = state.goals.filter((goal) => goal.category === category).length;
      const habitCount = state.habits.filter((habit) => habit.category === category).length;
      const row = document.createElement("div");
      row.className = "category-edit-row";

      if (editingCategoryName === category) {
        row.classList.add("is-editing");
        row.innerHTML = `
          <label class="category-rename-field">
            Rename area
            <input type="text" value="${escapeHtml(category)}" data-rename-category-input="${escapeHtml(category)}">
          </label>
          <div class="category-actions">
            <button class="ghost-button" type="button" data-save-category="${escapeHtml(category)}">Save</button>
            <button class="ghost-button" type="button" data-cancel-category-edit>Cancel</button>
            <button class="delete-button category-remove-button" type="button" data-remove-category="${escapeHtml(category)}">Delete</button>
          </div>
        `;
        const input = row.querySelector("[data-rename-category-input]");
        row.querySelector("[data-save-category]").addEventListener("click", () => {
          renameCategory(category, input.value);
        });
        row.querySelector("[data-cancel-category-edit]").addEventListener("click", () => {
          editingCategoryName = "";
          renderCategoryManager();
        });
        row.querySelector("[data-remove-category]").addEventListener("click", () => {
          openCategoryRemoveConfirm(category);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") renameCategory(category, input.value);
          if (event.key === "Escape") {
            editingCategoryName = "";
            renderCategoryManager();
          }
        });
        window.setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      } else {
        row.innerHTML = `
          <button class="category-edit-trigger" type="button" data-edit-category="${escapeHtml(category)}" aria-label="Edit ${escapeHtml(category)}">
            <span class="category-display">
              <strong>${escapeHtml(category)}</strong>
              <small>${goalCount} goals | ${habitCount} habits</small>
            </span>
            <span class="category-hover-label" aria-hidden="true">Edit</span>
          </button>
        `;
        row.querySelector("[data-edit-category]").addEventListener("click", () => {
          editingCategoryName = category;
          renderCategoryManager();
        });
      }

      manager.append(row);
    });
  });
}

function renderTaskHabitOptions() {
  document.querySelectorAll("[data-habit-link-select]").forEach((select) => {
    const previous = select.value;
    select.innerHTML = taskHabitOptionsMarkup(previous);
    select.value = findHabitById(previous) ? previous : "";
  });
}

function renderTaskGoalOptions() {
  document.querySelectorAll("[data-task-goal-support]").forEach((select) => {
    const previous = select.value;
    const support = parseGoalStepValue(previous);
    select.innerHTML = goalStepSelectMarkup(support.goalId, support.stepId);
    select.value = support.goalId && support.stepId ? `${support.goalId}:${support.stepId}` : "";
  });
}

function renderTasks() {
  document.querySelectorAll("[data-task-list]").forEach((list) => {
    list.innerHTML = "";
    [...state.tasks]
      .sort((a, b) => {
        const overdueDelta = Number(isTaskOverdue(b)) - Number(isTaskOverdue(a));
        if (overdueDelta) return overdueDelta;
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      })
      .forEach((task) => list.append(taskRow(task)));
  });
  renderTaskHabitOptions();
  renderTaskGoalOptions();
  toggleEmpty("tasks", state.tasks.length === 0);
}

function isTaskOverdue(task) {
  return Boolean(task.deadline && !task.done && task.deadline < todayKey());
}

function taskDeadlineLabel(task) {
  if (!task.deadline) return "No deadline";
  if (isTaskOverdue(task)) return `Overdue - due ${formatDisplayDate(task.deadline)}`;
  if (task.deadline === todayKey()) return "Due today";
  return `Due ${formatDisplayDate(task.deadline)}`;
}

function taskSupportLabel(task) {
  const { goal, step } = findGoalStep(task.supportedGoalId, task.supportedStepId);
  if (!goal || !step) return "";
  return `Supports ${goal.title}: ${step.text}`;
}

function taskRow(task) {
  const row = document.createElement("div");
  const habit = findHabitById(task.linkedHabitId);
  const supportLabel = taskSupportLabel(task);
  row.className = `task-row ${task.done ? "is-done" : ""} ${isTaskOverdue(task) ? "is-overdue" : ""}`;
  if (editingTaskId === task.id) {
    row.classList.add("is-editing-item");
    row.innerHTML = taskEditMarkup(task);
    bindTaskEditControls(row, task);
    return row;
  }
  row.innerHTML = `
    <div class="task-status-orb" aria-hidden="true">${task.done ? "✓" : ""}</div>
    <div class="task-copy">
      <strong>${escapeHtml(task.title)}</strong>
      ${task.subtext ? `<p>${escapeHtml(task.subtext)}</p>` : ""}
      <div class="task-meta-strip">
        <span class="${isTaskOverdue(task) ? "is-overdue-meta" : ""}">${escapeHtml(taskDeadlineLabel(task))}</span>
        <span>${task.taskType === "habit" ? "Habit-linked task" : "One-off task"}</span>
        <span>${habit ? `Linked habit: ${escapeHtml(habit.name)}` : "Not linked to a habit"}</span>
      </div>
      ${supportLabel ? `<span class="task-goal-support">${escapeHtml(supportLabel)}</span>` : ""}
    </div>
    <div class="task-actions">
      <button class="ghost-button edit-item-button" type="button" data-edit-task="${task.id}">Edit</button>
      <button class="daily-done-button ${task.done ? "is-done" : ""}" type="button" data-toggle-task="${task.id}">
        ${task.done ? "Mark open" : "Mark done"}
      </button>
      <button class="delete-button" type="button" data-delete-task="${task.id}">Delete</button>
    </div>
  `;
  row.querySelector("[data-edit-task]")?.addEventListener("click", () => {
    editingTaskId = task.id;
    render();
  });
  row.querySelector("[data-toggle-task]")?.addEventListener("click", () => {
    const match = state.tasks.find((item) => item.id === task.id);
    if (match) {
      match.done = !match.done;
      match.completedAt = match.done ? new Date().toISOString() : "";
    }
    saveAndRender();
  });
  row.querySelector("[data-delete-task]")?.addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete task?",
      copy: `This will delete "${task.title}" from your task board.`,
      confirmLabel: "Delete task",
      onConfirm: () => {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
        saveAndRender();
      }
    });
  });
  return row;
}

function taskEditMarkup(task) {
  return `
    <form class="edit-card-form task-edit-form" data-task-edit-form="${task.id}">
      <div class="edit-form-heading">
        <div>
          <p class="eyebrow">Edit task</p>
          <h3>${escapeHtml(task.title)}</h3>
        </div>
        <div class="edit-form-actions">
          <button class="text-button" type="submit">Save</button>
          <button class="ghost-button" type="button" data-cancel-task-edit>Cancel</button>
          <button class="delete-button" type="button" data-delete-task="${task.id}">Delete</button>
        </div>
      </div>
      <label>
        Task title
        <input name="title" type="text" value="${escapeHtml(task.title)}" required>
      </label>
      <label>
        Optional details
        <textarea name="subtext" rows="3">${escapeHtml(task.subtext)}</textarea>
      </label>
      ${deadlineFieldMarkup({ id: `task-edit-deadline-${task.id}`, value: task.deadline, required: true })}
      <label>
        Task type
        <select name="taskType">${taskTypeOptionsMarkup(task.taskType)}</select>
      </label>
      <label>
        Link to habit
        <select name="linkedHabitId">${taskHabitOptionsMarkup(task.linkedHabitId)}</select>
      </label>
      <label>
        Supports goal step
        <select name="supportedStepKey">${goalStepSelectMarkup(task.supportedGoalId, task.supportedStepId)}</select>
      </label>
    </form>
  `;
}

function bindTaskEditControls(row, task) {
  const form = row.querySelector("[data-task-edit-form]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireTaskDeadline(form)) return;
    const data = new FormData(form);
    const linkedHabit = findHabitById(data.get("linkedHabitId"));
    const support = parseGoalStepValue(data.get("supportedStepKey"));
    const deadline = dateFromValue(data.get("deadline"));
    task.title = String(data.get("title") || "").trim() || task.title;
    task.subtext = String(data.get("subtext") || "").trim();
    task.deadline = deadline ? dateToValue(deadline) : "";
    task.taskType = data.get("taskType") === "habit" ? "habit" : "task";
    task.linkedHabitId = linkedHabit ? linkedHabit.id : "";
    task.supportedGoalId = support.goalId;
    task.supportedStepId = support.stepId;
    editingTaskId = "";
    saveAndRender();
  });
  row.querySelector("[data-cancel-task-edit]")?.addEventListener("click", () => {
    editingTaskId = "";
    render();
  });
  row.querySelector("[data-delete-task]")?.addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete task?",
      copy: `This will delete "${task.title}" from your task board.`,
      confirmLabel: "Delete task",
      onConfirm: () => {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
        editingTaskId = "";
        saveAndRender();
      }
    });
  });
}

function linkedTaskMarkup(habit, key = selectedHabitDate()) {
  const tasks = tasksForHabit(habit.id, key);
  if (!tasks.length) return "";
  return `
    <div class="habit-linked-tasks">
      <span>Linked tasks due ${formatDisplayDate(key)}</span>
      ${tasks.map((task) => `
        <div class="habit-linked-task ${task.done ? "is-done" : ""} ${isTaskOverdue(task) ? "is-overdue" : ""}">
          <div>
            <strong>${escapeHtml(task.title)}</strong>
            ${task.subtext ? `<p>${escapeHtml(task.subtext)}</p>` : ""}
            <small>${task.done ? "Completed" : isTaskOverdue(task) ? "Overdue on this date" : "Attached to this habit"}</small>
          </div>
          <button class="daily-done-button linked-task-toggle ${task.done ? "is-done" : ""}" type="button" data-toggle-linked-task="${task.id}">
            ${task.done ? "Mark open" : "Mark done"}
          </button>
        </div>
      `).join("")}
    </div>
  `;
}

function categoryRemovalFallback(name) {
  return categoryList().find((category) => category !== name) || "Uncategorized";
}

function ensureDeleteConfirmDialog() {
  let dialog = document.querySelector("[data-delete-confirm]");
  if (dialog) return dialog;

  dialog = document.createElement("aside");
  dialog.className = "category-confirm-overlay";
  dialog.dataset.deleteConfirm = "";
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="category-confirm-card" role="dialog" aria-modal="true" aria-labelledby="category-confirm-title">
      <p class="eyebrow" data-delete-confirm-eyebrow>Confirm delete</p>
      <h2 id="category-confirm-title" data-delete-confirm-title>Delete item?</h2>
      <p data-delete-confirm-copy></p>
      <div class="category-confirm-actions">
        <button class="delete-button confirm-delete-button" type="button" data-confirm-delete>Confirm delete</button>
        <button class="ghost-button" type="button" data-cancel-delete>Cancel</button>
      </div>
    </div>
  `;
  document.body.append(dialog);

  dialog.querySelector("[data-confirm-delete]").addEventListener("click", () => {
    const action = pendingDeleteAction?.onConfirm;
    closeDeleteConfirm();
    if (typeof action === "function") action();
  });
  dialog.querySelector("[data-cancel-delete]").addEventListener("click", closeDeleteConfirm);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDeleteConfirm();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) closeDeleteConfirm();
  });
  return dialog;
}

function openDeleteConfirm({ eyebrow = "Confirm delete", title = "Delete item?", copy = "", confirmLabel = "Confirm delete", onConfirm }) {
  pendingDeleteAction = { onConfirm };
  const dialog = ensureDeleteConfirmDialog();
  const eyebrowTarget = dialog.querySelector("[data-delete-confirm-eyebrow]");
  const titleTarget = dialog.querySelector("[data-delete-confirm-title]");
  const copyTarget = dialog.querySelector("[data-delete-confirm-copy]");
  const confirmTarget = dialog.querySelector("[data-confirm-delete]");
  if (eyebrowTarget) eyebrowTarget.textContent = eyebrow;
  if (titleTarget) titleTarget.textContent = title;
  if (copyTarget) copyTarget.textContent = copy;
  if (confirmTarget) confirmTarget.textContent = confirmLabel;
  dialog.hidden = false;
  document.body.classList.add("has-category-confirm");
  window.setTimeout(() => {
    confirmTarget?.focus();
  }, 0);
}

function closeDeleteConfirm() {
  pendingDeleteAction = null;
  pendingCategoryRemoval = "";
  const dialog = document.querySelector("[data-delete-confirm]");
  if (dialog) dialog.hidden = true;
  document.body.classList.remove("has-category-confirm");
}

function openCategoryRemoveConfirm(category) {
  pendingCategoryRemoval = category;
  const fallback = categoryRemovalFallback(category);
  openDeleteConfirm({
    eyebrow: "Confirm delete",
    title: "Delete category?",
    copy: `This will remove "${category}". Existing goals and habits in this area will move to ${fallback}.`,
    confirmLabel: "Delete category",
    onConfirm: () => removeCategory(category)
  });
}

function setCategoryStatus(message) {
  document.querySelectorAll("[data-category-status]").forEach((status) => {
    status.textContent = message;
  });
}

function addCategory(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    setCategoryStatus("Name an area first.");
    return;
  }
  if (categoryList().some((category) => category.toLowerCase() === trimmed.toLowerCase())) {
    setCategoryStatus(`${trimmed} already exists.`);
    return;
  }
  state.categories.push(trimmed);
  saveAndRender();
  setCategoryStatus(`${trimmed} added.`);
}

function removeCategory(name) {
  const categories = categoryList();
  const remaining = categories.filter((category) => category !== name);
  const fallback = remaining[0] || "Uncategorized";
  state.categories = remaining;
  state.goals.forEach((goal) => {
    if (goal.category === name) goal.category = fallback;
  });
  state.habits.forEach((habit) => {
    if (habit.category === name) habit.category = fallback;
  });
  if (editingCategoryName === name) editingCategoryName = "";
  saveAndRender();
  setCategoryStatus(remaining.length ? `${name} removed. Existing items moved to ${fallback}.` : `${name} removed. Add a new area when you are ready.`);
}

function renameCategory(currentName, nextName) {
  const trimmed = String(nextName || "").trim();
  if (!trimmed) {
    setCategoryStatus("Name the area before saving.");
    return;
  }
  if (trimmed.toLowerCase() === currentName.toLowerCase()) {
    setCategoryStatus(`${currentName} is unchanged.`);
    return;
  }
  if (categoryList().some((category) => category.toLowerCase() === trimmed.toLowerCase())) {
    setCategoryStatus(`${trimmed} already exists.`);
    return;
  }

  state.categories = categoryList().map((category) => category === currentName ? trimmed : category);
  state.goals.forEach((goal) => {
    if (goal.category === currentName) goal.category = trimmed;
  });
  state.habits.forEach((habit) => {
    if (habit.category === currentName) habit.category = trimmed;
  });
  editingCategoryName = "";
  saveAndRender();
  setCategoryStatus(`${currentName} renamed to ${trimmed}.`);
}

function renderHabits() {
  document.querySelectorAll("[data-habit-table]").forEach((table) => {
    table.innerHTML = "";
    table.classList.add("daily-habit-table");
    table.append(dailyDateControl());
    if (!state.habits.length) return;
    const habitsForDate = scheduledHabitsForDate(selectedHabitDate());
    if (!habitsForDate.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact daily-empty-message";
      empty.innerHTML = `
        <strong>No habits scheduled for ${formatHabitDay(selectedHabitDate())}.</strong>
        <span>Add a habit above or change a habit's repeat days when it should appear here.</span>
      `;
      table.append(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "daily-habit-list";
    habitsForDate.forEach((habit) => list.append(dailyHabitRow(habit, selectedHabitDate())));
    table.append(list);
  });

  renderStreaks();
  renderEndOfDayReminders();
  toggleEmpty("dashboardHabits", state.habits.length === 0);
  toggleEmpty("habitsPage", state.habits.length === 0);
}

function dailyDateControl() {
  const control = document.createElement("div");
  control.className = "daily-date-control";
  const selected = selectedHabitDate();
  const selectedLabel = formatHabitDay(selected);
  control.innerHTML = `
    <div class="daily-date-copy">
      <span>Editing</span>
      <strong>${selectedLabel}</strong>
    </div>
    <div class="daily-date-strip" aria-label="Recent days">
      ${recentHabitDateKeys().map((key) => `
        <button class="daily-date-button ${key === selected ? "is-active" : ""}" type="button" data-date-select="${key}" aria-pressed="${key === selected}">
          <span title="${formatHabitDay(key)}">${formatHabitButtonDay(key)}</span>
          <small>${dateForKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
        </button>
      `).join("")}
    </div>
  `;
  control.querySelectorAll("[data-date-select]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedHabitDateKey = button.dataset.dateSelect;
      render();
    });
  });
  return control;
}

function dailyHabitRow(habit, key) {
  const row = document.createElement("div");
  const record = habitRecord(habit, key);
  const done = Boolean(record.done);
  const isReflecting = openReflectionKey === reflectionEditKey(habit.id, key);
  const canReflect = !done && (shouldShowReflection(key) || isReflecting);
  row.className = `daily-habit-row ${done ? "is-done" : ""}`;
  if (editingHabitId === habit.id) {
    row.classList.add("is-editing-item");
    row.innerHTML = habitEditMarkup(habit);
    bindHabitEditControls(row, habit);
    return row;
  }
  row.innerHTML = `
    <div class="daily-habit-main">
      <strong>${escapeHtml(habit.name)}</strong>
      <span>${escapeHtml(habit.category || fallbackCategory())} | ${formatHabitDay(key)} | ${escapeHtml(scheduleLabel(habit))}</span>
      ${habitSupportMarkup(habit)}
      ${linkedTaskMarkup(habit, key)}
    </div>
    <div class="daily-habit-actions">
      <button class="ghost-button edit-item-button" type="button" data-edit-habit="${habit.id}">Edit</button>
      <button class="daily-done-button ${done ? "is-done" : ""}" type="button" data-toggle-habit="${habit.id}" aria-pressed="${done}">
        ${done ? "Mark not done" : "Mark done"}
      </button>
      ${!done ? `<button class="ghost-button missed-button" type="button" data-reflect-missed="${habit.id}">Reflect missed</button>` : ""}
      <button class="delete-button habit-delete-button" type="button" data-delete-habit="${habit.id}" aria-label="Delete ${escapeHtml(habit.name)}">Delete</button>
    </div>
    ${canReflect || record.reflection ? `
      <div class="reflection-box">
        <label>
          Reflection
          <textarea data-reflection-input="${habit.id}" rows="2" placeholder="What got in the way? What will you try next?">${escapeHtml(record.reflection)}</textarea>
        </label>
        <button class="ghost-button" type="button" data-save-reflection="${habit.id}">${record.reflection ? "Update reflection" : "Save reflection"}</button>
      </div>
    ` : ""}
  `;
  row.querySelector("[data-edit-habit]")?.addEventListener("click", () => {
    editingHabitId = habit.id;
    render();
  });
  row.querySelector("[data-toggle-habit]")?.addEventListener("click", () => {
    const match = state.habits.find((item) => item.id === habit.id);
    if (match) {
      setHabitDone(match, key, !done);
      openReflectionKey = done ? reflectionEditKey(habit.id, key) : "";
    }
    saveAndRender();
  });
  row.querySelector("[data-reflect-missed]")?.addEventListener("click", () => {
    openReflectionKey = reflectionEditKey(habit.id, key);
    render();
    window.setTimeout(() => {
      document.querySelector(`[data-reflection-input="${habit.id}"]`)?.focus();
    }, 0);
  });
  row.querySelectorAll("[data-toggle-linked-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = state.tasks.find((item) => item.id === button.dataset.toggleLinkedTask);
      if (task) {
        task.done = !task.done;
        task.completedAt = task.done ? new Date().toISOString() : "";
      }
      saveAndRender();
    });
  });
  row.querySelector("[data-delete-habit]").addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete habit?",
      copy: `This will delete "${habit.name}" and its daily check history. Any goal steps linked to it will show a missing routine link.`,
      confirmLabel: "Delete habit",
      onConfirm: () => {
        state.habits = state.habits.filter((item) => item.id !== habit.id);
        saveAndRender();
      }
    });
  });
  row.querySelector("[data-save-reflection]")?.addEventListener("click", () => {
    const match = state.habits.find((item) => item.id === habit.id);
    const input = row.querySelector("[data-reflection-input]");
    if (match && input) setHabitReflection(match, key, input.value);
    openReflectionKey = "";
    saveAndRender();
  });
  return row;
}

function habitEditMarkup(habit) {
  return `
    <form class="edit-card-form habit-edit-form" data-habit-edit-form="${habit.id}">
      <div class="edit-form-heading">
        <div>
          <p class="eyebrow">Edit habit</p>
          <h3>${escapeHtml(habit.name)}</h3>
        </div>
        <div class="edit-form-actions">
          <button class="text-button" type="submit">Save</button>
          <button class="ghost-button" type="button" data-cancel-habit-edit>Cancel</button>
          <button class="delete-button" type="button" data-delete-habit="${habit.id}">Delete</button>
        </div>
      </div>
      <label>
        Habit name
        <input name="name" type="text" value="${escapeHtml(habit.name)}" required>
      </label>
      <label>
        Category
        <select name="category">${categoryOptionsMarkup(habit.category)}</select>
      </label>
      <div class="weekday-field">
        <div class="weekday-field-head">
          <strong>Repeat on</strong>
          <small>Only selected days will show this habit in the daily checklist.</small>
        </div>
        <div class="weekday-picker" data-edit-weekday-picker>${scheduleDayChoicesMarkup(habit.scheduleDays)}</div>
      </div>
      <label class="goal-support-field">
        Supports goal step
        <select name="supportedStepKey">${goalStepSelectMarkup(habit.supportedGoalId, habit.supportedStepId)}</select>
        <small>Optional. Use this when the habit supports a specific micro step.</small>
      </label>
    </form>
  `;
}

function bindHabitEditControls(row, habit) {
  const form = row.querySelector("[data-habit-edit-form]");
  let selectedDays = normalizeScheduleDays(habit.scheduleDays);
  const renderLocalDays = () => {
    const picker = row.querySelector("[data-edit-weekday-picker]");
    if (!picker) return;
    picker.innerHTML = scheduleDayChoicesMarkup(selectedDays);
  };
  row.addEventListener("click", (event) => {
    const weekday = event.target.closest("[data-edit-weekday]");
    if (!weekday) return;
    const day = Number(weekday.dataset.editWeekday);
    const next = selectedDays.includes(day) ? selectedDays.filter((item) => item !== day) : [...selectedDays, day];
    selectedDays = normalizeScheduleDays(next.length ? next : selectedDays);
    renderLocalDays();
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const support = parseGoalStepValue(data.get("supportedStepKey"));
    habit.name = String(data.get("name") || "").trim() || habit.name;
    habit.category = String(data.get("category") || fallbackCategory());
    habit.scheduleDays = normalizeScheduleDays(selectedDays);
    habit.weeklyGoal = habit.scheduleDays.length;
    habit.supportedGoalId = support.goalId;
    habit.supportedStepId = support.stepId;
    editingHabitId = "";
    saveAndRender();
  });
  row.querySelector("[data-cancel-habit-edit]")?.addEventListener("click", () => {
    editingHabitId = "";
    render();
  });
  row.querySelector("[data-delete-habit]")?.addEventListener("click", () => {
    openDeleteConfirm({
      eyebrow: "Confirm delete",
      title: "Delete habit?",
      copy: `This will delete "${habit.name}" and its daily check history. Any goal steps linked to it will show a missing routine link.`,
      confirmLabel: "Delete habit",
      onConfirm: () => {
        state.habits = state.habits.filter((item) => item.id !== habit.id);
        editingHabitId = "";
        saveAndRender();
      }
    });
  });
}

function habitSupportMarkup(habit) {
  if (!habit.supportedGoalId || !habit.supportedStepId) return "";
  const { goal, step } = findGoalStep(habit.supportedGoalId, habit.supportedStepId);
  if (!goal || !step) {
    return `<div class="habit-goal-support is-missing"><span>Goal support link missing</span></div>`;
  }
  return `
    <div class="habit-goal-support">
      <span>Supports goal</span>
      <strong>${escapeHtml(goal.title)} - ${escapeHtml(step.text)}</strong>
    </div>
  `;
}

function renderStreaks() {
  document.querySelectorAll("[data-streak-list]").forEach((list) => {
    list.innerHTML = "";
    state.habits.forEach((habit) => {
      const row = document.createElement("div");
      row.className = "streak-row";
      row.innerHTML = `
        <strong>${escapeHtml(habit.name)}</strong>
        <span>${habitStreak(habit)} scheduled checks | ${escapeHtml(scheduleLabel(habit))}</span>
      `;
      list.append(row);
    });
  });
  toggleEmpty("streaks", state.habits.length === 0);
}

function renderTodayReadouts() {
  document.querySelectorAll("[data-today-readout]").forEach((readout) => {
    readout.innerHTML = `<span>Today</span><strong>${formatTodayReadout()}</strong><small>${formatCurrentTimeReadout()}</small>`;
  });
}

function formatTodayReadout() {
  return new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatCurrentTimeReadout() {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function ensureAuthScreen() {
  if (document.querySelector("[data-auth-screen]")) return;
  const screen = document.createElement("section");
  screen.className = "auth-screen";
  screen.dataset.authScreen = "";
  screen.innerHTML = `
    <div class="auth-hud" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <article class="auth-card">
      <div class="auth-copy">
        <p class="eyebrow">Plan well</p>
        <h1>Your progress, saved to your account.</h1>
        <p>Log in or sign up to keep goals, habits, tasks, categories, reflections, and XP connected to you across devices.</p>
      </div>

      <div class="auth-tabs" role="tablist" aria-label="Account mode">
        <button class="auth-tab is-active" type="button" data-auth-mode="login">Login</button>
        <button class="auth-tab" type="button" data-auth-mode="signup">Sign up</button>
      </div>

      <div class="auth-setup" data-auth-setup hidden>
        <strong>Connect the backend to enable login</strong>
        <span>This is a setup notice, not a website bug. Add your Supabase project URL and anon key in <code>supabase-config.js</code>, then run <code>supabase/schema.sql</code> in Supabase.</span>
      </div>

      <button class="auth-provider-button" type="button" data-auth-google style="display: flex; align-items: center; justify-content: center; gap: 10px; cursor: pointer; padding: 12px 20px; font-size: 0.95rem; font-weight: 700; background: linear-gradient(135deg, rgba(0, 246, 255, 0.15), rgba(0, 18, 28, 0.85)); border: 1px solid rgba(0, 246, 255, 0.4); border-radius: 12px; color: #fff; box-shadow: 0 0 16px rgba(0,246,255,0.25);">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <span>Continue with Google</span>
      </button>

      <form class="auth-form" data-auth-email-form>
        <label>
          Email
          <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
        </label>
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" placeholder="Minimum 6 characters">
        </label>
        <div class="auth-actions">
          <button class="text-button" type="submit" data-auth-submit>Login with email</button>
          <button class="ghost-button" type="button" data-auth-magic>Send magic link</button>
        </div>
      </form>

      <p class="auth-status" data-auth-status aria-live="polite"></p>
      <button class="ghost-button compact-button" type="button" data-close-auth-screen style="margin-top: 6px; font-size: 0.8rem; border-color: rgba(0,246,255,0.3); color: #00f6ff;">&larr; Return to App / Dashboard</button>
    </article>
  `;
  document.body.prepend(screen);
}

function openAuthScreen() {
  ensureAuthScreen();
  bindAuthControls();
  const screen = document.querySelector("[data-auth-screen]");
  if (screen) {
    screen.style.setProperty("display", "grid", "important");
    screen.hidden = false;
  }
}

function bindAuthControls() {
  const screen = document.querySelector("[data-auth-screen]");
  if (!screen || screen.dataset.bound === "1") return;
  screen.dataset.bound = "1";
  let mode = "login";

  screen.querySelector("[data-close-auth-screen]")?.addEventListener("click", () => {
    localStorage.removeItem("planwell_force_auth");
    screen.style.setProperty("display", "none", "important");
    screen.hidden = true;
  });

  const setMode = (nextMode) => {
    mode = nextMode;
    screen.querySelectorAll("[data-auth-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.authMode === mode);
    });
    const submit = screen.querySelector("[data-auth-submit]");
    const password = screen.querySelector('input[name="password"]');
    if (submit) submit.textContent = mode === "signup" ? "Create account" : "Login with email";
    if (password) password.autocomplete = mode === "signup" ? "new-password" : "current-password";
    setAuthStatus("");
  };

  screen.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.authMode));
  });

  screen.querySelector("[data-auth-google]")?.addEventListener("click", async () => {
    if (!supabaseClient) {
      setAuthStatus("Supabase is not configured yet.");
      return;
    }
    setAuthStatus("Opening Google...");
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href.split("#")[0] }
    });
    if (error) setAuthStatus(error.message);
  });

  screen.querySelector("[data-auth-email-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient) {
      setAuthStatus("Supabase is not configured yet.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    if (!email || !password) {
      setAuthStatus("Enter an email and password.");
      return;
    }

    setAuthStatus(mode === "signup" ? "Creating account..." : "Logging in...");
    const response = mode === "signup"
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (response.error) {
      setAuthStatus(response.error.message);
      return;
    }
    setAuthStatus(mode === "signup" ? "Account created. Check your email if confirmation is enabled." : "Logged in.");
  });

  screen.querySelector("[data-auth-magic]")?.addEventListener("click", async () => {
    if (!supabaseClient) {
      setAuthStatus("Supabase is not configured yet.");
      return;
    }
    const email = String(screen.querySelector('input[name="email"]')?.value || "").trim();
    if (!email) {
      setAuthStatus("Enter your email first.");
      return;
    }
    setAuthStatus("Sending magic link...");
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] }
    });
    setAuthStatus(error ? error.message : "Magic link sent. Check your email.");
  });

  setMode("login");
}

function setAuthStatus(message) {
  document.querySelectorAll("[data-auth-status]").forEach((status) => {
    status.textContent = message;
  });
}

function renderAccountControls() {
  let chip = document.querySelector("[data-account-chip]");
  if (!currentUser) {
    chip?.remove();
    return;
  }

  if (!chip) {
    chip = document.createElement("div");
    chip.className = "account-chip";
    chip.dataset.accountChip = "";
    document.body.append(chip);
  }

  chip.innerHTML = `
    <button class="profile-button" type="button" data-profile-menu-toggle aria-label="Open profile menu" aria-expanded="false">
      <span class="profile-head" aria-hidden="true"></span>
      <span class="profile-shoulders" aria-hidden="true"></span>
    </button>
    <div class="profile-menu" data-profile-menu hidden>
      <div class="profile-menu-copy">
        <strong>${escapeHtml(authDisplayName())}</strong>
        <span>${escapeHtml(userEmail() || "Signed in")}</span>
        <em data-sync-status>${escapeHtml(syncStatus)}</em>
      </div>
      <button class="text-button compact-button" type="button" data-open-auth-screen style="width: 100%; margin-bottom: 8px; font-size: 0.78rem;">Log in / Sign in with Google</button>
      <button class="delete-button profile-signout-button" type="button" data-sign-out>Log out</button>
    </div>
  `;

  const menuButton = chip.querySelector("[data-profile-menu-toggle]");
  const menu = chip.querySelector("[data-profile-menu]");
  menuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    menuButton.setAttribute("aria-expanded", String(!isOpen));
  });
  chip.querySelector("[data-sign-out]")?.addEventListener("click", async () => {
    menu.hidden = true;
    menuButton?.setAttribute("aria-expanded", "false");
    openDeleteConfirm({
      eyebrow: "Confirm logout",
      title: "Log out?",
      copy: "You will return to the login screen. Your latest saved tracker state will stay connected to this account.",
      confirmLabel: "Log out",
      onConfirm: async () => {
        if (supabaseClient) await supabaseClient.auth.signOut();
        authSession = null;
        currentUser = null;
        applyState(createEmptyState());
        render();
        setAuthVisibility();
      }
    });
  });
}

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-auth-screen], [data-trigger-auth-preview], .mobile-login-btn, [data-auth-google-trigger]")) {
    event.preventDefault();
    openAuthScreen();
    return;
  }
  if (event.target.closest("[data-account-chip]")) return;
  document.querySelectorAll("[data-profile-menu]").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll("[data-profile-menu-toggle]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
});

function renderEndOfDayReminders() {
  const key = todayKey();
  const missed = todayMissedHabits();
  const dismissed = localStorage.getItem(reminderStorageKey(key)) === "1";
  const shouldShow = isEndOfDayWindow() && missed.length > 0 && !dismissed;

  document.querySelectorAll("[data-end-day-reminder]").forEach((panel) => {
    panel.hidden = !shouldShow;
    panel.innerHTML = "";
    if (!shouldShow) return;

    panel.innerHTML = `
      <div>
        <p class="eyebrow">End-of-day check</p>
        <h2>${missed.length} habit${missed.length === 1 ? "" : "s"} still open today.</h2>
        <p>${missed.map((habit) => escapeHtml(habit.name)).join(", ")}</p>
      </div>
      <div class="reminder-actions">
        <button class="text-button" type="button" data-review-habits>Review habits</button>
        <button class="ghost-button" type="button" data-dismiss-reminder>Dismiss tonight</button>
      </div>
    `;

    panel.querySelector("[data-review-habits]")?.addEventListener("click", () => {
      const target = document.querySelector("#habits-section") || document.querySelector("[data-habit-table]");
      target?.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start" });
    });
    panel.querySelector("[data-dismiss-reminder]")?.addEventListener("click", () => {
      localStorage.setItem(reminderStorageKey(key), "1");
      renderEndOfDayReminders();
    });
  });
}

function showSaveStatus(type) {
  const panel = document.querySelector(`[data-save-status="${type}"]`);
  if (!panel) return;
  document.querySelectorAll("[data-save-status]").forEach((item) => {
    item.hidden = item !== panel;
    item.classList.remove("is-visible");
  });
  panel.hidden = false;
  void panel.offsetWidth;
  panel.classList.add("is-visible");
}

function bindSaveGuidance() {
  document.querySelectorAll("[data-add-another]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.addAnother;
      const panel = document.querySelector(`[data-save-status="${type}"]`);
      const form = document.querySelector(`[data-${type}-form]`);
      if (panel) {
        panel.hidden = true;
        panel.classList.remove("is-visible");
      }
      if (form) {
        form.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "center" });
        window.setTimeout(() => {
          form.querySelector("input, select, textarea")?.focus();
        }, REDUCED_MOTION ? 0 : 320);
      }
    });
  });
}

function dateFromValue(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function dateToValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(value) {
  const date = dateFromValue(value);
  if (!date) return "Pick a deadline";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function calendarViewDate(field) {
  const year = Number(field.dataset.calendarYear);
  const month = Number(field.dataset.calendarMonth);
  if (Number.isInteger(year) && Number.isInteger(month)) return new Date(year, month, 1);
  const input = field.querySelector("[data-date-input]");
  const selected = dateFromValue(input?.value);
  const today = new Date();
  const base = selected || today;
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function setCalendarView(field, date) {
  field.dataset.calendarYear = String(date.getFullYear());
  field.dataset.calendarMonth = String(date.getMonth());
}

function closeDateCalendar(field) {
  const popover = field.querySelector("[data-date-popover]");
  const trigger = field.querySelector("[data-date-trigger]");
  if (popover) popover.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  field.classList.remove("is-open");
}

function closeAllDateCalendars(exceptField = null) {
  document.querySelectorAll("[data-date-field]").forEach((field) => {
    if (field !== exceptField) closeDateCalendar(field);
  });
}

function renderDateCalendar(field) {
  const popover = field.querySelector("[data-date-popover]");
  const input = field.querySelector("[data-date-input]");
  if (!popover || !input) return;

  const view = calendarViewDate(field);
  const selectedValue = input.value;
  const todayValue = dateToValue(new Date());
  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(year, month, 1 - firstDay.getDay());

  const dayButtons = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const value = dateToValue(date);
    const classes = [
      "date-day",
      date.getMonth() !== month ? "is-muted" : "",
      value === todayValue ? "is-today" : "",
      value === selectedValue ? "is-selected" : ""
    ].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-date-day="${value}" aria-label="${formatDisplayDate(value)}">${date.getDate()}</button>`;
  }).join("");

  popover.innerHTML = `
    <div class="date-calendar-head">
      <button class="date-nav" type="button" data-date-nav="-1" aria-label="Previous month">&lt;</button>
      <strong>${MONTH_NAMES[month]} ${year}</strong>
      <button class="date-nav" type="button" data-date-nav="1" aria-label="Next month">&gt;</button>
    </div>
    <div class="date-calendar-grid">
      ${CALENDAR_DAYS.map((day) => `<span class="date-weekday">${day}</span>`).join("")}
      ${dayButtons}
    </div>
  `;
}

function openDateCalendar(field) {
  closeAllDateCalendars(field);
  const popover = field.querySelector("[data-date-popover]");
  const trigger = field.querySelector("[data-date-trigger]");
  if (!popover || !trigger) return;
  setCalendarView(field, calendarViewDate(field));
  renderDateCalendar(field);
  popover.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  field.classList.add("is-open");
}

function syncDateHints() {
  document.querySelectorAll("[data-date-field]").forEach((field) => {
    const input = field.querySelector("[data-date-input]");
    const value = field.querySelector("[data-date-value]");
    if (value) value.textContent = formatDisplayDate(input?.value);
    field.classList.toggle("has-date", Boolean(input?.value));
  });
}

function bindDateHints() {
  document.querySelectorAll("[data-date-field]").forEach((field) => {
    if (field.dataset.dateBound === "true") return;
    const input = field.querySelector("[data-date-input]");
    const trigger = field.querySelector("[data-date-trigger]");
    const popover = field.querySelector("[data-date-popover]");
    if (!input || !trigger || !popover) return;
    field.dataset.dateBound = "true";

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      field.classList.remove("has-date-error");
      if (field.classList.contains("is-open")) {
        closeDateCalendar(field);
      } else {
        openDateCalendar(field);
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      openDateCalendar(field);
    });

    popover.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nav = event.target.closest("[data-date-nav]");
      if (nav) {
        const view = calendarViewDate(field);
        view.setMonth(view.getMonth() + Number(nav.dataset.dateNav));
        setCalendarView(field, view);
        renderDateCalendar(field);
        popover.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        field.classList.add("is-open");
        return;
      }

      const day = event.target.closest("[data-date-day]");
      if (!day) return;
      input.value = day.dataset.dateDay;
      field.classList.remove("has-date-error");
      setCalendarView(field, dateFromValue(input.value) || calendarViewDate(field));
      syncDateHints();
      renderDateCalendar(field);
      closeDateCalendar(field);
    });
  });

  if (!dateDocumentListenersBound) {
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-date-field]")) return;
      closeAllDateCalendars();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllDateCalendars();
    });
    dateDocumentListenersBound = true;
  }

  syncDateHints();
}

function requireTaskDeadline(form) {
  const field = form.querySelector("[data-required-date]");
  const input = field?.querySelector("[data-date-input]");
  if (dateFromValue(input?.value)) return true;
  field?.classList.add("has-date-error");
  if (field) {
    openDateCalendar(field);
    field.querySelector("[data-date-trigger]")?.focus();
  }
  return false;
}

function microStepLinesFromTextarea(form) {
  const textarea = form.querySelector('textarea[name="steps"]');
  return String(textarea?.value || "")
    .split("\n")
    .map((step) => step.trim())
    .filter(Boolean);
}

function microStepEntries(form) {
  const builder = form.querySelector("[data-micro-step-builder]");
  if (!builder) {
    return microStepLinesFromTextarea(form).map((text) => ({ text, routineIdea: "" }));
  }
  return [...builder.querySelectorAll("[data-micro-step-row]")]
    .map((row) => ({
      text: String(row.querySelector("[data-step-text]")?.value || "").trim(),
      routineIdea: String(row.querySelector("[data-step-routine]")?.value || "").trim()
    }))
    .filter((entry) => entry.text);
}

function microStepLines(form) {
  return microStepEntries(form).map((entry) => entry.text);
}

function collectRoutinePlannerChoices(form) {
  const builder = form.querySelector("[data-micro-step-builder]");
  if (builder) {
    const choices = microStepEntries(form).map((entry, index) => ({ ...entry, index }));
    form._routineLinkChoices = choices;
    return choices;
  }
  const existing = Array.isArray(form._routineLinkChoices) ? form._routineLinkChoices : [];
  const rows = [...form.querySelectorAll("[data-routine-step-index]")];
  if (!rows.length) return existing;

  const choices = rows.map((row, index) => {
    const mode = row.querySelector("[data-routine-mode]")?.value || "none";
    const habitId = row.querySelector("[data-routine-existing-habit]")?.value || "";
    const routineIdea = row.querySelector("[data-routine-idea]")?.value || "";
    return {
      text: row.dataset.routineStepText || "",
      mode,
      habitId,
      routineIdea,
      index
    };
  });
  form._routineLinkChoices = choices;
  return choices;
}

function syncMicroStepBackingField(form) {
  const textarea = form.querySelector('textarea[name="steps"]');
  if (!textarea) return;
  textarea.value = microStepEntries(form).map((entry) => entry.text).join("\n");
}

function makeMicroStepRow(form, entry = {}, index = 0) {
  const row = document.createElement("div");
  row.className = "micro-step-builder-row";
  row.dataset.microStepRow = "";
  const routineVal = escapeHtml(entry.routineIdea || "");
  row.innerHTML = `
    <div class="micro-step-builder-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
    <label class="micro-step-title-field">
      <span class="field-label">Step ${index + 1}</span>
      <input type="text" data-step-text placeholder="${index === 0 ? "First milestone, like master grammar" : "Next milestone"}" value="${escapeHtml(entry.text || "")}">
    </label>
    <div class="micro-step-habit-field">
      <span class="field-label">Habit link <small style="font-weight:normal;opacity:0.65;margin-left:2px;">(Optional)</small></span>
      <input type="hidden" data-step-routine value="${routineVal}">
      <button type="button" class="micro-step-habit-btn" data-step-routine-btn title="Click to set up a habit for this step on Habits page">
        ${entry.routineIdea ? `Linked: ${routineVal}` : `+ Build Habit for Step`}
      </button>
    </div>
    <button class="ghost-button micro-step-remove" type="button" data-remove-micro-step aria-label="Remove step ${index + 1}">Remove</button>
  `;
  row.querySelector("[data-step-text]")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addMicroStepRow(form, row);
  });
  // Redirect to habits page when user clicks the habit link button
  row.querySelector("[data-step-routine-btn]")?.addEventListener("click", () => {
    const goalTitleInput = form.querySelector('[name="title"]');
    const goalTitle = goalTitleInput ? goalTitleInput.value.trim() : "";
    const stepText = row.querySelector("[data-step-text]")?.value.trim() || "";
    const params = new URLSearchParams();
    if (goalTitle) params.set("linkedGoal", goalTitle);
    if (stepText) params.set("linkedStep", stepText);
    const base = window.location.pathname.includes("/mobile/") ? "../habits.html" : "habits.html";
    window.location.href = `${base}?${params.toString()}`;
  });
  row.querySelector("[data-step-text]")?.addEventListener("input", () => {
    syncMicroStepBackingField(form);
    renderRoutineLinkPlanner(form);
  });
  row.querySelector("[data-remove-micro-step]")?.addEventListener("click", () => {
    const builder = form.querySelector("[data-micro-step-builder]");
    const rows = builder ? [...builder.querySelectorAll("[data-micro-step-row]")] : [];
    if (rows.length <= 1) {
      row.querySelector("[data-step-text]").value = "";
      const inputRoutine = row.querySelector("[data-step-routine]");
      if (inputRoutine) inputRoutine.value = "";
    } else {
      row.remove();
    }
    refreshMicroStepRows(form);
    syncMicroStepBackingField(form);
    renderRoutineLinkPlanner(form);
  });
  return row;
}

function addMicroStepRow(form, afterRow = null, entry = {}) {
  const list = form.querySelector("[data-micro-step-list]");
  if (!list) return;
  const index = [...list.querySelectorAll("[data-micro-step-row]")].length;
  const row = makeMicroStepRow(form, entry, index);
  if (afterRow?.parentElement === list) {
    afterRow.after(row);
  } else {
    list.append(row);
  }
  refreshMicroStepRows(form);
  syncMicroStepBackingField(form);
  window.setTimeout(() => row.querySelector("[data-step-text]")?.focus(), 0);
}

function refreshMicroStepRows(form) {
  form.querySelectorAll("[data-micro-step-row]").forEach((row, index) => {
    const number = String(index + 1).padStart(2, "0");
    row.querySelector(".micro-step-builder-index").textContent = number;
    const stepLabel = row.querySelector("label:first-of-type");
    const removeButton = row.querySelector("[data-remove-micro-step]");
    if (stepLabel) stepLabel.firstChild.textContent = `Step ${index + 1}`;
    if (removeButton) removeButton.setAttribute("aria-label", `Remove step ${index + 1}`);
  });
}

function resetMicroStepBuilder(form) {
  const builder = form.querySelector("[data-micro-step-builder]");
  const list = form.querySelector("[data-micro-step-list]");
  if (!builder || !list) return;
  list.innerHTML = "";
  list.append(makeMicroStepRow(form, {}, 0));
  syncMicroStepBackingField(form);
  renderRoutineLinkPlanner(form);
}

function ensureMicroStepBuilder(form) {
  if (form.querySelector("[data-micro-step-builder]")) return;
  const textarea = form.querySelector('textarea[name="steps"]');
  const field = textarea?.closest("label");
  if (!textarea || !field) return;
  const entries = microStepLinesFromTextarea(form).map((text) => ({ text, routineIdea: "" }));
  field.classList.add("micro-step-source-field");
  textarea.hidden = true;
  textarea.setAttribute("aria-hidden", "true");
  const builder = document.createElement("div");
  builder.className = "micro-step-builder full-width";
  builder.dataset.microStepBuilder = "";
  builder.innerHTML = `
    <div class="micro-step-builder-head">
      <div>
        <strong>Micro steps</strong>
        <span>Type one milestone, press Enter, then plan the routine that helps you reach it.</span>
      </div>
      <button class="ghost-button" type="button" data-add-micro-step>Add step</button>
    </div>
    <div class="micro-step-builder-list" data-micro-step-list></div>
  `;
  field.after(builder);
  const list = builder.querySelector("[data-micro-step-list]");
  (entries.length ? entries : [{}]).forEach((entry, index) => {
    list.append(makeMicroStepRow(form, entry, index));
  });
  builder.querySelector("[data-add-micro-step]")?.addEventListener("click", () => addMicroStepRow(form));
  syncMicroStepBackingField(form);
}

function routineChoiceForLine(form, text, index) {
  const choices = collectRoutinePlannerChoices(form);
  const exact = choices.find((choice) => choice.index === index && choice.text === text);
  if (exact) return exact;
  return choices.find((choice) => choice.text === text) || { text, mode: "none", habitId: "", index };
}

function renderRoutineLinkPlanner(form) {
  ensureMicroStepBuilder(form);
  const planner = form.querySelector("[data-routine-link-planner]");
  if (!planner) return;

  const entries = microStepEntries(form);
  if (!entries.length) {
    form._routineLinkChoices = [];
    planner.innerHTML = `
      <div class="routine-planner-empty">
        <strong>Daily routine support</strong>
        <span>Add your first micro step above. Each step can include the daily routine that will help you reach it.</span>
      </div>
    `;
    return;
  }

  form._routineLinkChoices = entries.map((entry, index) => ({ ...entry, index }));

  planner.innerHTML = `
    <div class="routine-planner-heading">
      <div>
        <strong>Daily routine support</strong>
        <span>Micro steps measure success. Add habits separately when a routine needs to be checked on scheduled days.</span>
      </div>
      <small>${entries.length} step${entries.length === 1 ? "" : "s"} planned</small>
    </div>
  `;
}

function renderRoutineLinkPlanners() {
  document.querySelectorAll("[data-goal-form]").forEach(renderRoutineLinkPlanner);
}

function bindRoutinePlanner(form) {
  ensureMicroStepBuilder(form);
  form.querySelector('select[name="category"]')?.addEventListener("change", () => renderRoutineLinkPlanner(form));
}

function stepsFromGoalForm(form, category) {
  const entries = microStepEntries(form);
  return entries.map((entry) => {
    return normalizeStep({ id: uid("step"), text: entry.text, done: false, routineIdea: entry.routineIdea || "", linkedHabitTarget: 7 });
  });
}

function ensureWeekdayPicker(form) {
  if (form.querySelector("[data-weekday-picker]")) return;
  const categoryField = form.querySelector(".category-field") || form.querySelector('select[name="category"]')?.closest("label");
  if (!categoryField) return;
  const field = document.createElement("div");
  field.className = "weekday-field";
  field.innerHTML = `
    <div class="weekday-field-head">
      <strong>Repeat on</strong>
      <small>Choose the days this habit belongs in your life.</small>
    </div>
    <div class="weekday-picker" data-weekday-picker aria-label="Choose repeat days"></div>
  `;
  categoryField.after(field);
  form._scheduleDays = [...ALL_WEEKDAYS];
}

function selectedScheduleDays(form) {
  const selected = Array.isArray(form._scheduleDays) ? normalizeScheduleDays(form._scheduleDays) : [...ALL_WEEKDAYS];
  return selected;
}

function renderWeekdayPickers() {
  document.querySelectorAll("[data-habit-form]").forEach((form) => {
    ensureWeekdayPicker(form);
    const picker = form.querySelector("[data-weekday-picker]");
    if (!picker) return;
    const selected = selectedScheduleDays(form);
    picker.innerHTML = DAYS.map((day, index) => `
      <button class="weekday-choice ${selected.includes(index) ? "is-selected" : ""}" type="button" data-weekday-choice="${index}" aria-pressed="${selected.includes(index)}">
        ${day}
      </button>
    `).join("");
    picker.querySelectorAll("[data-weekday-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        const day = Number(button.dataset.weekdayChoice);
        const current = selectedScheduleDays(form);
        const next = current.includes(day) ? current.filter((item) => item !== day) : [...current, day];
        form._scheduleDays = normalizeScheduleDays(next.length ? next : current);
        renderWeekdayPickers();
      });
    });
  });
}

function scheduleLabel(habit) {
  const days = normalizeScheduleDays(habit.scheduleDays);
  if (days.length === 7) return "Every day";
  return days.map((day) => DAYS[day]).join(", ");
}

function ensureGoalSupportPicker(form) {
  if (form.querySelector("[data-goal-step-support-field]")) return;
  const actions = form.querySelector(".form-actions") || form.querySelector('button[type="submit"]')?.parentElement;
  if (!actions) return;
  const field = document.createElement("label");
  field.className = "goal-support-field";
  field.dataset.goalStepSupportField = "";
  field.innerHTML = `
    Supports goal step
    <select name="supportedStepKey" data-goal-step-support></select>
    <small>Optional. Use this when a habit helps a specific goal milestone.</small>
  `;
  actions.before(field);
}

function renderGoalSupportPickers() {
  const options = goalStepOptions();
  document.querySelectorAll("[data-habit-form]").forEach((form) => {
    ensureGoalSupportPicker(form);
    const select = form.querySelector("[data-goal-step-support]");
    if (!select) return;
    const previous = select.value;
    select.innerHTML = `
      <option value="">No goal step selected</option>
      ${options.map((option) => `
        <option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>
      `).join("")}
    `;
    select.value = options.some((option) => option.value === previous) ? previous : "";
  });
}

function bindForms() {
  document.querySelectorAll("[data-category-form]").forEach((categoryForm) => {
    categoryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(categoryForm);
      addCategory(form.get("categoryName"));
      categoryForm.reset();
      categoryForm.querySelector("input")?.focus();
    });
  });

  document.querySelectorAll("[data-goal-form]").forEach((goalForm) => {
    bindRoutinePlanner(goalForm);
    goalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(goalForm);
      const category = String(form.get("category") || fallbackCategory());
      const steps = stepsFromGoalForm(goalForm, category);
      state.goals.push({
        id: uid("goal"),
        title: String(form.get("title") || "").trim(),
        category,
        deadline: String(form.get("deadline") || ""),
        why: String(form.get("why") || "").trim(),
        measure: String(form.get("measure") || "").trim(),
        reward: String(form.get("reward") || "").trim(),
        steps,
        complete: false
      });
      goalForm.reset();
      goalForm._routineLinkChoices = [];
      resetMicroStepBuilder(goalForm);
      renderRoutineLinkPlanner(goalForm);
      window.setTimeout(syncDateHints, 0);
      saveAndRender();
      showSaveStatus("goal");
    });
  });

  document.querySelectorAll("[data-habit-form]").forEach((habitForm) => {
    ensureWeekdayPicker(habitForm);
    ensureGoalSupportPicker(habitForm);
    habitForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(habitForm);
      const support = parseGoalStepValue(form.get("supportedStepKey"));
      state.habits.push(makeHabit(
        form.get("name"),
        form.get("category"),
        selectedScheduleDays(habitForm),
        support.goalId,
        support.stepId
      ));
      habitForm.reset();
      habitForm._scheduleDays = [...ALL_WEEKDAYS];
      const weeklyInput = habitForm.querySelector('[name="weeklyGoal"]');
      if (weeklyInput) weeklyInput.value = 7;
      renderWeekdayPickers();
      renderGoalSupportPickers();
      saveAndRender();
      showSaveStatus("habit");
    });
  });

  document.querySelectorAll("[data-task-form]").forEach((taskForm) => {
    taskForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireTaskDeadline(taskForm)) return;
      const form = new FormData(taskForm);
      const support = parseGoalStepValue(form.get("supportedStepKey"));
      state.tasks.push(makeTask(
        form.get("title"),
        form.get("subtext"),
        form.get("linkedHabitId"),
        form.get("deadline"),
        support.goalId,
        support.stepId,
        form.get("taskType")
      ));
      taskForm.reset();
      renderTaskHabitOptions();
      renderTaskGoalOptions();
      syncDateHints();
      saveAndRender();
      taskForm.querySelector("input, textarea, select")?.focus();
    });
  });
}

function saveAndRender() {
  saveState();
  render();
}

function render() {
  renderTodayReadouts();
  syncMetrics();
  renderCategoryOptions();
  renderWeekdayPickers();
  renderGoalSupportPickers();
  renderRoutineLinkPlanners();
  renderGoals();
  renderCategories();
  renderTasks();
  renderHabits();
  render21DayHabitsSection();
  renderNotificationsSection();
  bindDateHints();
  syncDateHints();
}

function toggleEmpty(name, shouldShow) {
  document.querySelectorAll(`[data-empty="${name}"]`).forEach((element) => {
    element.hidden = !shouldShow;
  });
}

function categoryClass(category) {
  const map = {
    Health: "health",
    School: "study",
    Hobbies: "creative"
  };
  return map[category] || "study";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage can be unavailable in some browser modes.
  }
}

function safeSessionTake(key) {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

function pulseControl(control) {
  if (!control || REDUCED_MOTION) return;
  control.classList.remove("is-activating");
  void control.offsetWidth;
  control.classList.add("is-activating");
  window.setTimeout(() => control.classList.remove("is-activating"), 420);
}

function pulseSection(section) {
  if (!section || REDUCED_MOTION) return;
  section.classList.remove("section-arriving");
  void section.offsetWidth;
  section.classList.add("section-arriving");
  window.setTimeout(() => section.classList.remove("section-arriving"), 1100);
}

function scrollToHashSection(hash, control) {
  const target = document.querySelector(hash);
  if (!target) return false;
  pulseControl(control);
function renderGoalSupportPickers() {
  const options = goalStepOptions();
  document.querySelectorAll("[data-habit-form]").forEach((form) => {
    ensureGoalSupportPicker(form);
    const select = form.querySelector("[data-goal-step-support]");
    if (!select) return;
    const previous = select.value;
    select.innerHTML = `
      <option value="">No goal step selected</option>
      ${options.map((option) => `
        <option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>
      `).join("")}
    `;
    select.value = options.some((option) => option.value === previous) ? previous : "";
  });
}

function bindForms() {
  document.querySelectorAll("[data-category-form]").forEach((categoryForm) => {
    categoryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(categoryForm);
      addCategory(form.get("categoryName"));
      categoryForm.reset();
      categoryForm.querySelector("input")?.focus();
    });
  });

  document.querySelectorAll("[data-goal-form]").forEach((goalForm) => {
    bindRoutinePlanner(goalForm);
    goalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(goalForm);
      const category = String(form.get("category") || fallbackCategory());
      const steps = stepsFromGoalForm(goalForm, category);
      state.goals.push({
        id: uid("goal"),
        title: String(form.get("title") || "").trim(),
        category,
        deadline: String(form.get("deadline") || ""),
        why: String(form.get("why") || "").trim(),
        measure: String(form.get("measure") || "").trim(),
        reward: String(form.get("reward") || "").trim(),
        steps,
        complete: false
      });
      goalForm.reset();
      goalForm._routineLinkChoices = [];
      resetMicroStepBuilder(goalForm);
      renderRoutineLinkPlanner(goalForm);
      window.setTimeout(syncDateHints, 0);
      saveAndRender();
      showSaveStatus("goal");
    });
  });

  document.querySelectorAll("[data-habit-form]").forEach((habitForm) => {
    ensureWeekdayPicker(habitForm);
    ensureGoalSupportPicker(habitForm);
    habitForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(habitForm);
      const support = parseGoalStepValue(form.get("supportedStepKey"));
      state.habits.push(makeHabit(
        form.get("name"),
        form.get("category"),
        selectedScheduleDays(habitForm),
        support.goalId,
        support.stepId
      ));
      habitForm.reset();
      habitForm._scheduleDays = [...ALL_WEEKDAYS];
      const weeklyInput = habitForm.querySelector('[name="weeklyGoal"]');
      if (weeklyInput) weeklyInput.value = 7;
      renderWeekdayPickers();
      renderGoalSupportPickers();
      saveAndRender();
      showSaveStatus("habit");
    });
  });

  document.querySelectorAll("[data-task-form]").forEach((taskForm) => {
    taskForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!requireTaskDeadline(taskForm)) return;
      const form = new FormData(taskForm);
      const support = parseGoalStepValue(form.get("supportedStepKey"));
      state.tasks.push(makeTask(
        form.get("title"),
        form.get("subtext"),
        form.get("linkedHabitId"),
        form.get("deadline"),
        support.goalId,
        support.stepId,
        form.get("taskType")
      ));
      taskForm.reset();
      renderTaskHabitOptions();
      renderTaskGoalOptions();
      syncDateHints();
      saveAndRender();
      taskForm.querySelector("input, textarea, select")?.focus();
    });
  });
}

function saveAndRender() {
  saveState();
  render();
}

function render() {
  renderTodayReadouts();
  syncMetrics();
  renderCategoryOptions();
  renderWeekdayPickers();
  renderGoalSupportPickers();
  renderRoutineLinkPlanners();
  renderGoals();
  renderCategories();
  renderTasks();
  renderHabits();
  render21DayHabitsSection();
  renderNotificationsSection();
  bindDateHints();
  syncDateHints();
}

function toggleEmpty(name, shouldShow) {
  document.querySelectorAll(`[data-empty="${name}"]`).forEach((element) => {
    element.hidden = !shouldShow;
  });
}

function categoryClass(category) {
  const map = {
    Health: "health",
    School: "study",
    Hobbies: "creative"
  };
  return map[category] || "study";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage can be unavailable in some browser modes.
  }
}

function safeSessionTake(key) {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

function pulseControl(control) {
  if (!control || REDUCED_MOTION) return;
  control.classList.remove("is-activating");
  void control.offsetWidth;
  control.classList.add("is-activating");
  window.setTimeout(() => control.classList.remove("is-activating"), 420);
}

function pulseSection(section) {
  if (!section || REDUCED_MOTION) return;
  section.classList.remove("section-arriving");
  void section.offsetWidth;
  section.classList.add("section-arriving");
  window.setTimeout(() => section.classList.remove("section-arriving"), 1100);
}

function scrollToHashSection(hash, control) {
  const target = document.querySelector(hash);
  if (!target) return false;
  pulseControl(control);
  history.pushState(null, "", hash);
  target.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start" });
  pulseSection(target);
  return true;
}

function runPageArrival() {
  if (REDUCED_MOTION) return;
  const source = safeSessionTake("planwell-transition-source");
  document.body.dataset.transitionSource = source || "direct";
  document.body.classList.add("page-arriving");
  window.setTimeout(() => {
    document.body.classList.remove("page-arriving");
    delete document.body.dataset.transitionSource;
  }, 900);
}

function bindLinkMotion() {
  document.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (link.target && link.target !== "_self") ||
        link.hasAttribute("download")
      ) {
        return;
      }

      const destination = new URL(link.getAttribute("href"), window.location.href);
      if (destination.origin !== window.location.origin) return;

      const sameDocument = destination.pathname === window.location.pathname && destination.search === window.location.search;
      if (sameDocument && destination.hash) {
        if (!document.querySelector(destination.hash)) return;
        event.preventDefault();
        scrollToHashSection(destination.hash, link);
        return;
      }

      if (destination.href === window.location.href) {
        event.preventDefault();
        pulseControl(link);
        return;
      }

      event.preventDefault();
      pulseControl(link);
      safeSessionSet("planwell-transition-source", link.textContent.trim() || "link");
      document.body.classList.add("page-exiting");
      window.setTimeout(() => {
        window.location.href = destination.href;
      }, REDUCED_MOTION ? 0 : 280);
    });
  });
}

function bindDashboardSectionLinks() {
  document.querySelectorAll("[data-dashboard-section-link]").forEach((link) => {
    const heading = link.closest(".summary-lane-heading");
    if (!heading) return;
    heading.addEventListener("click", (event) => {
      const rect = link.getBoundingClientRect();
      const buffer = 12;
      const clickIsInsideButton =
        event.clientX >= rect.left - buffer &&
        event.clientX <= rect.right + buffer &&
        event.clientY >= rect.top - buffer &&
        event.clientY <= rect.bottom + buffer;

      if (!clickIsInsideButton) return;
      event.preventDefault();
      event.stopPropagation();
      scrollToHashSection(link.getAttribute("href"), link);
    }, true);
  });
}

function bindButtonMotion() {
  document.querySelectorAll("button, .text-button, .ghost-button, .check").forEach((control) => {
    control.addEventListener("pointerdown", () => pulseControl(control));
  });
}

function bindScrollNav() {
  const links = [...document.querySelectorAll(".nav-list a")];
  if (!links.length) return;

  const sectionPairs = links
    .map((link) => {
      const href = link.getAttribute("href") || "";
      let hash = href.includes("#") ? href.split("#")[1] : "";
      if (!hash && href.endsWith(".html")) {
        const pageName = href.replace(".html", "").replace("index", "dashboard");
        hash = pageName === "dashboard" ? "dashboard" : `${pageName}-section`;
      }
      const section = hash ? document.getElementById(hash) || document.querySelector(`#${hash}`) : null;
      return { link, section };
    })
    .filter((pair) => pair.section);

  if (!sectionPairs.length) return;

  let ticking = false;
  const updateActive = () => {
    let currentPair = sectionPairs[0];
    const threshold = window.innerHeight * 0.42;

    sectionPairs.forEach((pair) => {
      const rect = pair.section.getBoundingClientRect();
      if (rect.top <= threshold && rect.bottom > 0) {
        currentPair = pair;
      }
    });

    links.forEach((link) => {
      const isCurrent = link === currentPair.link;
      link.classList.toggle("active", isCurrent);
      if (isCurrent) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    ticking = false;
  };

  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateActive);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  updateActive();
}

/* ==========================================================================
   21-DAY HABIT PSYCHOLOGY PROTOCOL WIDGET
   ========================================================================== */

function render21DayHabitsSection() {
  document.querySelectorAll("[data-21day-habits-container]").forEach((container) => {
    container.innerHTML = "";
    if (!state.habits || !state.habits.length) {
      container.innerHTML = `
        <div class="habit-21day-empty-visual">
          <div class="empty-visual-header">
            <span class="psych-badge-chip">NEURAL REWIRING</span>
            <span class="xp-tag">+500 XP Boost</span>
          </div>
          <p class="empty-visual-desc">
            Brain science shows <strong>21 consecutive days</strong> lock a habit into your neural pathway. Start your first habit commitment today!
          </p>
          <div class="habit-21day-timeline-preview">
            <div class="timeline-step active-step">
              <span class="step-num">Day 1</span>
              <span class="step-label">Trigger</span>
            </div>
            <div class="timeline-connector"></div>
            <div class="timeline-step">
              <span class="step-num">Day 7</span>
              <span class="step-label">Routine</span>
            </div>
            <div class="timeline-connector"></div>
            <div class="timeline-step">
              <span class="step-num">Day 14</span>
              <span class="step-label">Lock-in</span>
            </div>
            <div class="timeline-connector"></div>
            <div class="timeline-step master-step">
              <span class="step-num">Day 21</span>
              <span class="step-label">Mastery</span>
            </div>
          </div>
          <button class="text-button primary-btn start-21day-btn" type="button" data-start-21day-btn>
            + Start 21-Day Habit Protocol
          </button>
        </div>
      `;
      container.querySelector("[data-start-21day-btn]")?.addEventListener("click", () => {
        if (typeof window.navigateToSection === "function") {
          window.navigateToSection("#habits-section");
        } else {
          const habitsSec = document.getElementById("habits-section") || document.getElementById("habits");
          if (habitsSec) habitsSec.scrollIntoView({ behavior: "smooth" });
          else window.location.href = window.location.pathname.includes("/mobile/") ? "../habits.html" : "habits.html";
        }
      });
      return;
    }

    const today = todayKey();
    state.habits.forEach((habit) => {
      const streak = habitStreak(habit);
      const dayCount = Math.min(21, streak);
      const isCompleted21 = streak >= 21;
      const doneToday = habitDoneOn(habit, today);
      const percent = Math.round((dayCount / 21) * 100);

      const card = document.createElement("div");
      card.className = `habit-21day-item ${isCompleted21 ? "is-mastered" : ""}`;
      card.style.cssText = "background: linear-gradient(135deg, rgba(0,246,255,0.06), rgba(0,18,28,0.7)); border: 1px solid rgba(0,246,255,0.25); border-radius: 14px; padding: 14px; margin-bottom: 12px; box-shadow: 0 4px 18px rgba(0,0,0,0.3);";
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div>
            <strong style="color: #fff; font-size: 0.95rem; display: flex; align-items: center; gap: 6px;">
              ${escapeHtml(habit.name)} ${isCompleted21 ? '<span style="background:rgba(0,255,208,0.2);color:#00ffd0;font-size:0.7rem;padding:2px 8px;border-radius:12px;border:1px solid rgba(0,255,208,0.4);">21-Day Master</span>' : ''}
            </strong>
            <span style="display: block; font-size: 0.76rem; color: #7caab4; margin-top: 2px;">
              ${escapeHtml(habit.category)} &bull; <span style="color:#00ffd0;font-weight:700;">${streak} day streak</span>
            </span>
          </div>
          <button class="ghost-button compact-button" type="button" data-check-21day="${habit.id}" ${doneToday ? "disabled" : ""} style="font-size: 0.78rem; padding: 6px 12px; border-radius: 10px; font-weight: 700; ${doneToday ? 'opacity:0.6;background:rgba(0,255,208,0.1);color:#00ffd0;' : 'color:#00f6ff;border-color:rgba(0,246,255,0.4);'}">
            ${doneToday ? "Checked Today" : "Check In"}
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
          <div style="flex: 1; height: 8px; background: rgba(0,246,255,0.1); border-radius: 999px; overflow: hidden; border: 1px solid rgba(0,246,255,0.2);">
            <div style="width: ${percent}%; height: 100%; background: linear-gradient(90deg, #00f6ff, #00ffd0); box-shadow: 0 0 10px rgba(0,246,255,0.6); transition: width 400ms ease;"></div>
          </div>
          <span style="font-size: 0.78rem; font-weight: 800; color: ${isCompleted21 ? "#00ffd0" : "#a8d7df"}; min-width: 70px; text-align: right;">
            ${isCompleted21 ? "Mastered!" : `Day ${dayCount} / 21`}
          </span>
        </div>
      `;

      card.querySelector("[data-check-21day]")?.addEventListener("click", () => {
        setHabitDone(habit, today, true);
        const newStreak = habitStreak(habit);
        if (newStreak === 21) {
          addNotification({
            title: `21-Day Habit Master Unlocked!`,
            body: `Incredible! You completed 21 consecutive days of "${habit.name}"! +500 XP Boost awarded!`,
            type: "reward"
          });
        } else {
          addNotification({
            title: `Habit Checked: ${habit.name}`,
            body: `Streak is now ${newStreak} days! Keep it up for your 21-Day Master Badge!`,
            type: "habit"
          });
        }
        saveAndRender();
      });

      container.append(card);
    });
  });
}

function evaluateRemindersAndDeadlines() {
  if (!state.habits || !state.tasks || !state.goals) return;

  const today = todayKey();
  const missedHabits = state.habits.filter((h) => !habitDoneOn(h, today));
  const overdueTasks = state.tasks.filter((t) => !t.complete && t.dueDate && t.dueDate < today);
  const dueGoals = state.goals.filter((g) => !g.complete && g.deadline);

  const todayStr = dateToValue(new Date());
  const lastCheck = localStorage.getItem("planwell_last_notif_check");
  if (lastCheck === todayStr) return;
  localStorage.setItem("planwell_last_notif_check", todayStr);

  if (missedHabits.length) {
    addNotification({
      title: `Daily Habit Reminder`,
      body: `You have ${missedHabits.length} habit(s) left to complete today (${missedHabits.map((h) => h.name).slice(0, 2).join(", ")}).`,
      type: "habit"
    });
  }

  if (overdueTasks.length) {
    addNotification({
      title: `Overdue Task Warning`,
      body: `${overdueTasks.length} task(s) are past due! (e.g. "${overdueTasks[0].title}").`,
      type: "task"
    });
  }

  if (dueGoals.length) {
    addNotification({
      title: `Goal Deadline Alert`,
      body: `Goal "${dueGoals[0].title}" deadline is approaching within 48 hours!`,
      type: "goal"
    });
  }
}

function renderNotificationsSection() {
  const unreadCount = (state.notifications || []).filter((n) => !n.read).length;
  document.querySelectorAll("[data-notification-count]").forEach((badge) => {
    badge.textContent = unreadCount;
    badge.hidden = unreadCount === 0;
  });

  document.querySelectorAll("[data-os-notif-toggle]").forEach((toggle) => {
    toggle.checked = Boolean(state.notificationSettings?.osEnabled);
  });

  document.querySelectorAll("[data-notification-list]").forEach((container) => {
    container.innerHTML = "";
    if (!state.notifications || !state.notifications.length) {
      container.innerHTML = `<div style="color: #94a3b8; font-size: 11px; text-align: center; padding: 12px;">No notifications yet.</div>`;
      return;
    }

    state.notifications.forEach((item) => {
      const row = document.createElement("div");
      row.style.cssText = "padding: 8px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; font-size: 11px; color: #cbd5e1;";
      row.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-weight: bold; color: #00e5ff; margin-bottom: 2px;">
          <span>${escapeHtml(item.title)}</span>
          <small style="color: #64748b; font-weight: normal;">${escapeHtml(item.time)}</small>
        </div>
        <div>${escapeHtml(item.body)}</div>
      `;
      container.append(row);
    });
  });
}

function bindNotificationControls() {
  document.querySelectorAll("[data-notification-trigger]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const drawer = btn.closest(".notification-wrapper")?.querySelector("[data-notification-drawer]");
      if (drawer) {
        drawer.hidden = !drawer.hidden;
        if (!drawer.hidden && state.notifications) {
          state.notifications.forEach((n) => (n.read = true));
          renderNotificationsSection();
        }
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-notification-drawer]") && !e.target.closest("[data-notification-trigger]")) {
      document.querySelectorAll("[data-notification-drawer]").forEach((d) => (d.hidden = true));
    }
  });

  document.querySelectorAll("[data-clear-notifications]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.notifications = [];
      saveAndRender();
    });
  });

  document.querySelectorAll("[data-os-notif-toggle]").forEach((toggle) => {
    toggle.addEventListener("change", async () => {
      if (toggle.checked) {
        if ("Notification" in window) {
          const permission = await Notification.requestPermission();
          if (permission === "granted") {
            if (!state.notificationSettings) state.notificationSettings = {};
            state.notificationSettings.osEnabled = true;
            addNotification({ title: "OS Notifications Enabled", body: "You will now receive native device notifications for habits, tasks, and goal deadlines.", type: "system" });
          } else {
            alert("Notification permission was denied in your browser settings.");
            toggle.checked = false;
            if (!state.notificationSettings) state.notificationSettings = {};
            state.notificationSettings.osEnabled = false;
          }
        } else {
          alert("OS Notifications are not supported by this browser.");
          toggle.checked = false;
          if (!state.notificationSettings) state.notificationSettings = {};
          state.notificationSettings.osEnabled = false;
        }
      } else {
        if (!state.notificationSettings) state.notificationSettings = {};
        state.notificationSettings.osEnabled = false;
      }
      saveAndRender();
    });
  });

  document.querySelectorAll("[data-test-os-notif]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!("Notification" in window)) {
        alert("Browser does not support OS notifications.");
        return;
      }
      let perm = Notification.permission;
      if (perm !== "granted") {
        perm = await Notification.requestPermission();
      }
      if (perm === "granted") {
        new Notification("Plan Well Alert", { body: "Daily habits, task reminders, and goal deadline alerts are active." });
      } else {
        alert("Notification permission denied in browser.");
      }
    });
  });
}

function bindProfileModalControls() {
  document.querySelectorAll("[data-open-profile-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = document.querySelector("[data-profile-modal]");
      if (!modal) return;
      modal.hidden = false;
      modal.style.display = "grid";
      const form = modal.querySelector("[data-edit-profile-form]");
      if (form) {
        const usernameInput = form.querySelector('[name="username"]');
        const handleInput = form.querySelector('[name="handle"]');
        if (usernameInput) usernameInput.value = state.userProfile?.username || authDisplayName();
        if (handleInput) handleInput.value = state.userProfile?.handle || "@user_01";
      }
    });
  });

  document.querySelectorAll("[data-close-profile-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = document.querySelector("[data-profile-modal]");
      if (modal) {
        modal.hidden = true;
        modal.style.display = "none";
      }
    });
  });

  document.querySelectorAll("[data-edit-profile-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const formData = new FormData(form);
      const username = String(formData.get("username") || "").trim();
      const handle = String(formData.get("handle") || "").trim();
      if (!state.userProfile) state.userProfile = {};
      state.userProfile.username = username;
      state.userProfile.handle = handle;
      saveAndRender();
      const modal = document.querySelector("[data-profile-modal]");
      if (modal) {
        modal.hidden = true;
        modal.style.display = "none";
      }
    });
  });
}

async function initializeApp() {
  document.body.classList.add("is-auth-loading");
  ensureAuthScreen();
  bindAuthControls();
  runPageArrival();
  bindForms();
  bindDateHints();
  bindSaveGuidance();
  bindDashboardSectionLinks();
  bindLinkMotion();
  bindButtonMotion();
  bindScrollNav();
  bindNotificationControls();
  bindProfileModalControls();
  initSupabaseClient();

  if (isLocalPreview()) {
    await bootstrapUserState(null);
  } else if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      await bootstrapUserState(data.session);
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (!authInitialized && event === "INITIAL_SESSION") return;
        await bootstrapUserState(session);
        render();
        setAuthVisibility();
      });
    } catch (error) {
      applyState(loadState());
      setSyncStatus("Using local cache - auth failed");
      console.error("Plan Well auth failed", error);
    }
  } else {
    applyState(createEmptyState());
  }

  authInitialized = true;
  evaluateRemindersAndDeadlines();
  render();
  setAuthVisibility();
  window.setInterval(() => {
    renderTodayReadouts();
    renderEndOfDayReminders();
    evaluateRemindersAndDeadlines();
  }, 60000);

  // Auto-fill habit form if arriving from goal step routine click
  const urlParams = new URLSearchParams(window.location.search);
  const linkedGoalTitle = urlParams.get("linkedGoal");
  const linkedStepText = urlParams.get("linkedStep");
  if (linkedGoalTitle && document.querySelector("[data-habit-form]")) {
    window.setTimeout(() => {
      const habitSection = document.querySelector("[data-habit-form]")?.closest("section, article, .panel");
      if (habitSection && !habitSection.querySelector(".linked-goal-banner")) {
        const banner = document.createElement("div");
        banner.className = "linked-goal-banner";
        banner.style.cssText = "background:rgba(0,246,255,0.08);border:1px solid rgba(0,246,255,0.3);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:0.82rem;color:#a8d7df;";
        banner.innerHTML = `<strong style="color:#00f6ff;">Linked from goal:</strong> <em>${escapeHtml(linkedGoalTitle)}</em>${linkedStepText ? ` &mdash; step: <em>${escapeHtml(linkedStepText)}</em>` : ""}. Set the frequency, schedule and reminders below, then save.`;
        habitSection.prepend(banner);
      }
      if (linkedStepText) {
        const nameInput = document.querySelector("[data-habit-form] input[name='name'], [data-habit-form] input[name='title']");
        if (nameInput && !nameInput.value) nameInput.value = linkedStepText;
      }
      const goalSelect = document.querySelector("[data-goal-step-support]");
      if (goalSelect) {
        const matchOption = [...goalSelect.options].find((opt) => opt.text.toLowerCase().includes(linkedGoalTitle.toLowerCase()));
        if (matchOption) goalSelect.value = matchOption.value;
      }
    }, 400);
  }
}

void initializeApp();
