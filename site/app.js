"use strict";

const CATS = {
  concerts: ["Concerts", "🎸"],
  theatre: ["Theatre", "🎭"],
  classical: ["Classical & Ballet", "🩰"],
  football: ["Football", "⚽"],
  sport: ["Other sport", "🏟️"],
  comedy: ["Comedy", "🎤"],
};
const PAGE = 60;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let events = [];
let byId = new Map();
let shown = [];
let limit = PAGE;
let tab = "all";
let saved = store.get("saved", {});
const state = { cats: Object.keys(CATS), when: "any", from: "", to: "", area: "all", ...store.get("filters", {}), q: "" };
if (state.when === "date") state.when = "custom"; // older single-date setting

// ------------------------------------------------------------------ dates

const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function range() {
  const today = londonToday();
  switch (state.when) {
    case "today":
      return [today, today];
    case "weekend": {
      const sunday = addDays(today, (7 - new Date(today + "T12:00:00Z").getUTCDay()) % 7);
      const friday = addDays(sunday, -2);
      return [friday > today ? friday : today, sunday];
    }
    case "week":
      return [today, addDays(today, 6)];
    case "month":
      return [today, addDays(today, 29)];
    case "custom": {
      let from = state.from > today ? state.from : today;
      let to = state.to || "9999";
      if (to < from) [from, to] = [to, from];
      return [from, to];
    }
  }
  return [today, "9999"];
}

function fmtPrice(g) {
  if (g.p == null) return "";
  const money = (n) => (n ? "£" + (n % 1 ? n.toFixed(2) : n) : "Free");
  return g.pm > g.p ? `${money(g.p)} – ${money(g.pm)}` : money(g.p);
}

function fmtWhen([when]) {
  const [day, time] = when.split("T");
  const d = new Date(day + "T12:00:00Z");
  const opts = { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" };
  if (day.slice(0, 4) !== londonToday().slice(0, 4)) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts) + (time ? `, ${time}` : "");
}

function fmtUpdated(iso) {
  const hours = Math.round((Date.now() - new Date(iso)) / 36e5);
  if (hours < 1) return "Updated just now";
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

// --------------------------------------------------------------- filtering

const hay = (g) => (g._h ??= `${g.t} ${g.v} ${g.a} ${g.g} ${g.sd || ""}`.toLowerCase());

function inArea(g) {
  if (state.area === "all") return true;
  if (state.area === "london") return g.a === "London";
  if (state.area === "trips") return g.a !== "London";
  return g.a === state.area;
}

function apply() {
  const today = londonToday();
  const [from, to] = range();
  const q = state.q.trim().toLowerCase();
  shown = [];

  if (tab === "saved") {
    for (const g of Object.values(saved)) {
      if (q && !hay(g).includes(q)) continue;
      shown.push({ g, dates: g.d.filter((x) => x[0].slice(0, 10) >= today) });
    }
  } else {
    for (const g of events) {
      if (!state.cats.includes(g.c) || !inArea(g) || (q && !hay(g).includes(q))) continue;
      const dates = g.d.filter((x) => {
        const day = x[0].slice(0, 10);
        return day >= from && day <= to;
      });
      if (dates.length) shown.push({ g, dates });
    }
  }
  shown.sort((a, b) => (a.dates[0]?.[0] ?? "~").localeCompare(b.dates[0]?.[0] ?? "~"));
  limit = PAGE;
  render();
}

// ---------------------------------------------------------------- rendering

function thumb(g, cls) {
  if (!g.img) return "";
  const crest = g.s === "football-data.org" ? " crest" : "";
  return `<img class="${cls}${crest}" src="${esc(g.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`;
}

function card({ g, dates }) {
  const [label, icon] = CATS[g.c];
  const place = g.a && g.a !== "London" ? `${g.v} · ${g.a}` : g.v;
  const extra = dates.length > 1 ? ` <span class="more-dates">+${dates.length - 1} more</span>` : "";
  const price = fmtPrice(g);
  const kind = g.sd || g.g;
  return `<li class="card" data-id="${esc(g.id)}">
    <div class="thumb">${thumb(g, "") || icon}</div>
    <div class="info">
      <p class="kind"><span class="tag c-${g.c}">${label}</span>${kind ? ` · ${esc(kind)}` : ""}</p>
      <h3>${esc(g.t)}</h3>
      <p class="meta">${esc(place)}</p>
      <p class="when">${dates.length ? fmtWhen(dates[0]) + extra : "No upcoming dates"}${price ? ` · <span class="price">${price}</span>` : ""}</p>
    </div>
    <button class="star${saved[g.id] ? " on" : ""}" data-star="${esc(g.id)}" aria-label="Save">★</button>
  </li>`;
}

function render() {
  const list = $("#list");
  const n = shown.length;
  if (!n) {
    list.innerHTML = "";
    $("#count").textContent = "";
    list.innerHTML = `<li class="empty">${
      tab === "saved"
        ? "Nothing saved yet. Tap ★ on any event to keep it here."
        : "No events match. Try another date, area or category."
    }</li>`;
  } else {
    $("#count").textContent = `${n.toLocaleString("en-GB")} ${n === 1 ? "event" : "events"}`;
    list.innerHTML = shown.slice(0, limit).map(card).join("");
  }
  $("#more").hidden = limit >= n;
  const savedN = Object.keys(saved).length;
  $("#savedCount").textContent = savedN ? `(${savedN})` : "";
}

// ------------------------------------------------------------------ detail

const find = (id) => byId.get(id) || saved[id];

function calendarUrl(g, [when, url]) {
  const [day, time] = when.split("T");
  let dates;
  if (time) {
    const end = new Date(`${day}T${time}:00Z`);
    end.setUTCHours(end.getUTCHours() + (g.c === "football" ? 2 : 3));
    dates = `${day.replace(/-/g, "")}T${time.replace(":", "")}00/${end.toISOString().slice(0, 19).replace(/[-:]/g, "")}`;
  } else {
    dates = `${day.replace(/-/g, "")}/${addDays(day, 1).replace(/-/g, "")}`;
  }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: g.t,
    dates,
    ctz: "Europe/London",
    location: `${g.v}, ${g.a}`,
    details: url || "",
  });
  return "https://calendar.google.com/calendar/render?" + params;
}

function dateRow(g, x) {
  const linkLabel = g.s === "football-data.org" ? "Club site" : "Tickets";
  const tbc = x[2] ? " <em>(time TBC)</em>" : "";
  return `<li>
    <span>${fmtWhen(x)}${tbc}</span>
    ${x[1] ? `<a class="btn" href="${esc(x[1])}" target="_blank" rel="noopener">${linkLabel}</a>` : ""}
    <a class="btn ghost" href="${esc(calendarUrl(g, x))}" target="_blank" rel="noopener" aria-label="Add to calendar">📅</a>
  </li>`;
}

function openDetail(id, showAll = false) {
  const g = find(id);
  if (!g) return;
  const today = londonToday();
  const upcoming = g.d.filter((x) => x[0].slice(0, 10) >= today);
  const visible = showAll ? upcoming : upcoming.slice(0, 20);
  const map = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(`${g.v}, ${g.a}`);
  const hero = thumb(g, "hero") || `<div class="no-hero"></div>`;

  $("#sheet").innerHTML = `<div class="sheet-inner">
    <button class="close" data-close aria-label="Close">←</button>
    ${hero}
    <div class="pad">
      <span class="tag c-${g.c}">${CATS[g.c][0]}</span>${g.g ? `<span class="genre">${esc(g.g)}</span>` : ""}
      <h2>${esc(g.t)}</h2>
      ${g.x ? `<p class="desc">${esc(g.x)}${g.w ? ` <a class="wiki" href="https://en.wikipedia.org/wiki/${encodeURIComponent(g.w.replace(/ /g, "_"))}" target="_blank" rel="noopener">Wikipedia</a>` : ""}</p>` : ""}
      <ul class="facts">
        <li>📍 <a href="${esc(map)}" target="_blank" rel="noopener">${esc(g.v)}${g.a ? ", " + esc(g.a) : ""}</a></li>
        <li>💷 ${fmtPrice(g) || (g.s === "football-data.org" ? "Prices on the club's website" : `Prices on ${esc(g.s)} – tap Tickets`)}</li>
      </ul>
      <button class="save-big${saved[g.id] ? " on" : ""}" data-star="${esc(g.id)}">${saved[g.id] ? "★ Saved" : "☆ Save"}</button>
      <h4>${upcoming.length ? `${upcoming.length} upcoming ${upcoming.length === 1 ? "date" : "dates"}` : "No upcoming dates"}</h4>
      <ul class="dates">${visible.map((x) => dateRow(g, x)).join("")}</ul>
      ${visible.length < upcoming.length ? `<button class="more all-dates" data-all="${esc(g.id)}">Show all ${upcoming.length} dates</button>` : ""}
      <p class="src">Listing from ${esc(g.s)}. Check the ticket site for final details.</p>
    </div>
  </div>`;

  const sheet = $("#sheet");
  if (sheet.hidden) {
    sheet.hidden = false;
    document.body.classList.add("locked");
    history.pushState({ detail: id }, ""); // so the phone's back button closes it
  }
  if (!showAll) sheet.scrollTop = 0;
}

function closeDetail() {
  $("#sheet").hidden = true;
  document.body.classList.remove("locked");
}

// ------------------------------------------------------------------- saving

function toggleSave(id) {
  const g = find(id);
  if (!g) return;
  if (saved[id]) delete saved[id];
  else saved[id] = g;
  store.set("saved", saved);
  if (!$("#sheet").hidden) openDetail(id);
  if (tab === "saved") apply();
  else render();
}

// ------------------------------------------------------------------- wiring

function saveFilters() {
  const { q, ...rest } = state;
  store.set("filters", rest);
}

function setupControls() {
  $("#cats").innerHTML = Object.entries(CATS)
    .map(([key, [label]]) => `<button class="chip c-${key}" data-cat="${key}" aria-pressed="${state.cats.includes(key)}">${label}</button>`)
    .join("");
  $("#cats").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cat]");
    if (!chip) return;
    const key = chip.dataset.cat;
    state.cats = state.cats.includes(key) ? state.cats.filter((c) => c !== key) : [...state.cats, key];
    chip.setAttribute("aria-pressed", state.cats.includes(key));
    saveFilters();
    apply();
  });

  const when = $("#when");
  const custom = $("#custom");
  const from = $("#from");
  const to = $("#to");
  const syncDates = () => {
    from.value = state.from;
    to.value = state.to;
    from.min = londonToday();
    to.min = state.from || londonToday();
    custom.hidden = state.when !== "custom";
  };
  when.value = state.when;
  syncDates();
  when.addEventListener("change", () => {
    state.when = when.value;
    if (state.when === "custom" && (!state.from || state.from < londonToday())) {
      state.from = londonToday();
      state.to = addDays(state.from, 6);
    }
    syncDates();
    saveFilters();
    apply();
  });
  for (const input of [from, to]) {
    input.addEventListener("change", () => {
      state[input.id] = input.value;
      if (state.from && state.to && state.to < state.from) state.to = state.from;
      syncDates();
      saveFilters();
      apply();
    });
  }

  $("#area").addEventListener("change", (e) => {
    state.area = e.target.value;
    saveFilters();
    apply();
  });

  let timer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value;
      apply();
    }, 150);
  });

  $("#list").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) return toggleSave(star.dataset.star);
    const item = e.target.closest(".card");
    if (item) openDetail(item.dataset.id);
  });

  $("#sheet").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return history.back();
    const star = e.target.closest("[data-star]");
    if (star) return toggleSave(star.dataset.star);
    const all = e.target.closest("[data-all]");
    if (all) openDetail(all.dataset.all, true);
  });
  window.addEventListener("popstate", closeDetail);

  const more = $("#more");
  const showMore = () => {
    limit += PAGE;
    render();
  };
  more.addEventListener("click", showMore);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !more.hidden) showMore();
  }, { rootMargin: "400px" }).observe(more);

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn || btn.dataset.tab === tab) return;
    tab = btn.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    document.body.classList.toggle("saved-tab", tab === "saved");
    window.scrollTo(0, 0);
    apply();
  });
}

async function load() {
  let data;
  try {
    const res = await fetch("events.json", { cache: "no-cache" });
    data = await res.json();
  } catch {
    $("#count").textContent = "Couldn't load events. Check your internet connection and reopen the app.";
    return;
  }
  events = data.events;
  byId = new Map(events.map((g) => [g.id, g]));

  // Refresh saved events with today's data (new dates, prices); keep ones that vanished.
  for (const id of Object.keys(saved)) if (byId.has(id)) saved[id] = byId.get(id);
  store.set("saved", saved);

  const area = $("#area");
  const counts = {};
  for (const g of events) counts[g.a] = (counts[g.a] || 0) + 1;
  area.insertAdjacentHTML(
    "beforeend",
    `<optgroup label="Day trips">${data.areas
      .filter((a) => a !== "London" && counts[a])
      .map((a) => `<option value="${esc(a)}">${esc(a)}</option>`)
      .join("")}</optgroup>`
  );
  area.value = state.area;
  if (area.value !== state.area) state.area = area.value = "all";

  $("#updated").textContent = fmtUpdated(data.updated);
  apply();
}

setupControls();
load();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
