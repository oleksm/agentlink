(() => {
  if (window.registryOwnerActionsLoaded) return;
  window.registryOwnerActionsLoaded = true;
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  async function refresh(section) {
    if (section.dataset.busy === "yes") return;
    if ([...section.querySelectorAll("textarea")].some((n) => n.value.trim()))
      return;
    if (
      location.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(location.hostname)
    ) {
      section.replaceChildren(el("h2", "Action Required"));
      const link = el(
        "a",
        "Open the local registry to provide approvals and directions",
      );
      link.href = "/" + location.hash;
      section.append(link);
      return;
    }
    try {
      const url =
        "/api/projects/" +
        encodeURIComponent(section.dataset.project) +
        "/actions";
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Cannot load actions");
      if (!section.isConnected) return;
      const signature = JSON.stringify([data.actions, data.history]);
      if (section.dataset.signature === signature) return;
      section.dataset.signature = signature;
      section.replaceChildren(el("h2", "Action Required"));
      const notice = el(
        "p",
        section.dataset.saved ||
          "Your decisions are saved as the owner in the project record. Scope approval does not itself accept or merge artifacts.",
      );
      notice.setAttribute("role", "status");
      section.append(notice);
      async function send(form, choice, action) {
        const detail = form.querySelector("textarea").value.trim();
        if (["reject", "direction"].includes(choice) && !detail) {
          notice.textContent = "Add a reason or direction first.";
          return;
        }
        section.dataset.busy = "yes";
        section.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          const reply = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Owner-Token": data.token,
            },
            body: JSON.stringify({
              request_id: crypto.randomUUID(),
              target: action?.id,
              revision: action?.revision,
              choice,
              detail,
            }),
          });
          const result = await reply.json();
          if (!reply.ok) throw Error(result.error || "Could not save");
          section.dataset.saved = result.message;
          form.querySelector("textarea").value = "";
          notice.textContent = result.message;
          delete section.dataset.signature;
        } catch (error) {
          notice.textContent = error.message;
        } finally {
          section.dataset.busy = "";
          section
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = false));
        }
        await refresh(section);
      }
      const table = el("table");
      const head = el("tr");
      ["Action", "Decision / direction"].forEach((t) =>
        head.append(el("th", t)),
      );
      table.append(head);
      for (const action of data.actions) {
        const row = el("tr"),
          description = el("td"),
          controls = el("td");
        description.append(el("strong", action.title));
        const more = el("details");
        more.append(el("summary", "Context"), el("p", action.context));
        description.append(more);
        const form = el("form");
        form.addEventListener("submit", (e) => e.preventDefault());
        const text = el("textarea");
        text.rows = 2;
        text.maxLength = 8000;
        text.placeholder = "Direction or reason (optional for approval)";
        text.setAttribute(
          "aria-label",
          "Direction or reason for " + action.title,
        );
        text.style.width = "100%";
        form.append(text);
        for (const [choice, label] of [
          ["approve", "Approve"],
          ["reject", "Reject"],
        ]) {
          const button = el("button", label);
          button.type = "button";
          button.addEventListener("click", () => send(form, choice, action));
          form.append(button);
        }
        controls.append(form);
        row.append(description, controls);
        table.append(row);
      }
      if (data.actions.length) section.append(table);
      else
        section.append(
          el("p", "No pending owner decisions or approval holds."),
        );
      const direction = el("form");
      direction.addEventListener("submit", (e) => e.preventDefault());
      direction.append(el("h3", "Add direction"));
      const text = el("textarea");
      text.rows = 3;
      text.maxLength = 8000;
      text.placeholder =
        "Describe what should happen next. Name a step or worker if relevant.";
      text.setAttribute("aria-label", "New project direction");
      text.style.width = "100%";
      direction.append(text);
      const button = el("button", "Send direction");
      button.type = "button";
      button.addEventListener("click", () => send(direction, "direction"));
      direction.append(button);
      section.append(direction);
      if (data.history.length) {
        const history = el("details");
        history.append(el("summary", "Recorded owner actions"));
        const list = el("ul");
        for (const entry of data.history)
          list.append(
            el(
              "li",
              new Date(entry.at).toLocaleString() + " — " + entry.detail,
            ),
          );
        history.append(list);
        section.append(history);
      }
    } catch (error) {
      section.replaceChildren(
        el("h2", "Action Required"),
        el("p", "Actions unavailable: " + error.message),
      );
      delete section.dataset.signature;
    }
  }
  const scan = () =>
    document.querySelectorAll("[data-owner-actions]").forEach((s) => {
      if (s.dataset.initialized) return;
      s.dataset.initialized = "yes";
      refresh(s);
    });
  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  scan();
  setInterval(
    () => document.querySelectorAll("[data-owner-actions]").forEach(refresh),
    15000,
  );
})();
