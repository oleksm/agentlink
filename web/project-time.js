// Display project timestamps in the viewer's timezone; keep recorded ISO times intact.
function projectLocalTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function projectElapsed(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now-at)/1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds/60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes/60);
  if (hours < 24) return `${hours}h ${minutes%60}m`;
  const days = Math.floor(hours/24);
  return `${days}d ${hours%24}h`;
}
function projectDue(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  return at > now ? `due in ${projectElapsed(new Date(now).toISOString(), at)}` : `overdue ${projectElapsed(value, now)}`;
}
function projectTimeMarkup(value, elapsed = false) {
  if (!value) return "";
  const safe = String(value).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<time datetime="${safe}" data-project-time="${elapsed ? "elapsed" : "local"}"></time>`;
}
function updateProjectTimes() {
  const now = Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.querySelectorAll("time[data-project-time]").forEach(el => {
    const local = projectLocalTime(el.dateTime);
    const text = el.dataset.projectTime === "elapsed" ? projectElapsed(el.dateTime, now) : el.dataset.projectTime === "due" ? projectDue(el.dateTime, now) : local;
    if (el.textContent !== text) el.textContent = text;
    const title = local ? `${local} (${zone})` : "";
    if (el.title !== title) el.title = title;
  });
}
function startProjectTimes() {
  updateProjectTimes();
  setInterval(updateProjectTimes, 1000);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; updateProjectTimes(); });
  }).observe(document.body, {childList:true, subtree:true});
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startProjectTimes, {once:true});
else startProjectTimes();

