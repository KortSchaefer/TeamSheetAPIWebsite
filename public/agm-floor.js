(() => {
  const $ = id => document.getElementById(id);
  const state = {
    stores: [], storeId: null, layouts: [], services: [], service: null, snapshot: null,
    currentView: "floor", selectedTable: null, selectedParty: null, zoom: 1,
    editorLayout: null, editorTables: [], editorSelected: null, editorSelectedTables: new Set(), editorFixtures: [], editorFixtureSelected: null, copiedTable: null, socket: null,
    seatMode: "SEAT", seatExistingTables: [], rotationOptions: null,
  };

  const authFetch = (url, options = {}) => fetch(url, { credentials: "include", ...options, headers: { ...(options.headers || {}) } });
  const json = async response => {
    if (response.ok) return response.status === 204 ? null : response.json();
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) location.href = "/static/login.html";
    const error = new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  };
  const api = (url, options) => authFetch(url, options).then(json);
  const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const put = (url, body) => api(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const patch = (url, body) => api(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `agm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const formatTime = value => value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const minutesSince = value => value ? Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000)) : 0;
  const partyStatus = party => String(party.status || "").replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase());

  function toast(message, error = false) {
    const el = document.createElement("div"); el.className = `toast${error ? " error" : ""}`; el.textContent = message;
    $("toast-region").appendChild(el); setTimeout(() => el.remove(), 4200);
  }
  function notice(message = "", error = false) {
    const el = $("notice"); el.textContent = message; el.className = `notice${message ? "" : " hidden"}${error ? " error" : ""}`;
  }
  function setSync(label, mode = "") { const el = $("sync-state"); el.className = `sync-state ${mode}`; el.innerHTML = `<i></i>${escapeHtml(label)}`; }

  function switchView(name) {
    state.currentView = name;
    document.querySelectorAll(".workspace-tabs button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    document.querySelectorAll("[data-workspace]").forEach(view => view.classList.toggle("active", view.dataset.workspace === name));
    if (name === "layouts") loadLayouts(true).catch(showError);
    if (name === "pacing") loadRotationOptions().catch(showError);
  }

  async function initialize() {
    $("service-date").value = new Date().toISOString().slice(0, 10);
    const payload = await api("/agm/bootstrap");
    state.stores = payload.stores;
    $("store-select").innerHTML = state.stores.map(store => `<option value="${store.id}">${escapeHtml(store.store_number)} · ${escapeHtml(store.name)}</option>`).join("");
    state.storeId = Number($("store-select").value || state.stores[0]?.id);
    if (!state.storeId) throw new Error("No AGM Floor store access is configured.");
    await Promise.all([loadLayouts(), loadServices()]);
    if (!state.service) setSync("Ready", "connected");
  }

  async function loadLayouts(render = false) {
    state.layouts = await api(`/agm/stores/${state.storeId}/layouts`);
    if (render || state.currentView === "layouts") renderLayoutList();
  }

  async function loadServices() {
    state.services = await api(`/agm/stores/${state.storeId}/services`);
    const select = $("service-select");
    select.innerHTML = state.services.length ? state.services.map(service => `<option value="${service.id}">${escapeHtml(service.name)} · ${service.service_date}${service.status === "CLOSED" ? " · closed" : ""}</option>`).join("") : '<option value="">No service open</option>';
    const open = state.services.find(service => service.status === "OPEN" && String(service.service_date).slice(0, 10) === $("service-date").value) || state.services.find(service => service.status === "OPEN") || state.services[0];
    if (open) { select.value = String(open.id); await loadService(open.id); }
    else {
      state.service = null; state.snapshot = null; renderAll();
      notice("Publish a layout, then open a service to begin seating.");
    }
  }

  async function loadService(serviceId) {
    if (!serviceId) return;
    setSync("Syncing");
    state.snapshot = await api(`/agm/services/${serviceId}/bootstrap`);
    state.service = state.snapshot.service;
    state.selectedTable = null;
    renderAll(); connectEvents(); setSync("Live", "connected"); notice("");
  }

  function renderAll() {
    renderMetrics(); renderQueue(); renderFloor(); renderDetail(); renderRotation(); renderLists(); renderPacing(); renderRotationSetup();
    const parties = state.snapshot?.parties || [];
    $("waitlist-count").textContent = parties.filter(p => p.source !== "RESERVATION" && ["WAITING", "NOTIFIED", "ARRIVED"].includes(p.status)).length;
    $("reservation-count").textContent = parties.filter(p => p.source === "RESERVATION" && !["COMPLETED", "CANCELLED", "NO_SHOW"].includes(p.status)).length;
  }

  function metrics() {
    const states = state.snapshot?.table_states || [], parties = state.snapshot?.parties || [];
    const seated = parties.filter(p => p.status === "SEATED");
    return {
      available: states.filter(row => row.status === "AVAILABLE").length,
      occupied: states.filter(row => row.status === "SEATED").length,
      covers: seated.reduce((sum, party) => sum + Number(party.party_size), 0),
      waiting: parties.filter(p => ["WAITING", "NOTIFIED", "ARRIVED"].includes(p.status)).length,
      avgTurn: seated.length ? Math.round(seated.reduce((sum, party) => sum + minutesSince(party.seated_at), 0) / seated.length) : 0,
    };
  }
  function renderMetrics() {
    const values = metrics();
    $("metric-strip").innerHTML = [
      ["Available tables", values.available, "Ready now"], ["Occupied", values.occupied, "Active tables"],
      ["Current covers", values.covers, "Guests seated"], ["Waiting", values.waiting, "Queue + arrivals"],
      ["Average live turn", `${values.avgTurn} min`, "Currently seated"],
    ].map(([label, value, help]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${help}</small></div>`).join("");
  }

  function activeQueue() {
    return (state.snapshot?.parties || []).filter(p => ["WAITING", "NOTIFIED", "ARRIVED"].includes(p.status)).sort((a, b) => new Date(a.reservation_at || a.created_at) - new Date(b.reservation_at || b.created_at));
  }
  function renderQueue() {
    const queue = activeQueue();
    $("queue-list").innerHTML = queue.length ? queue.map(party => `<article class="queue-card${state.selectedParty === party.id ? " selected" : ""}" data-party-id="${party.id}" tabindex="0"><div><strong>${escapeHtml(party.guest_name)}</strong><span>${escapeHtml(partyStatus(party))} · ${party.quoted_minutes ?? 0} min quote</span><small>${party.reservation_at ? formatTime(party.reservation_at) : "Walk-in"}${party.notes ? ` · ${escapeHtml(party.notes)}` : ""}</small></div><b class="party-size">${party.party_size}</b></article>`).join("") : '<div class="empty-copy">No parties are waiting.</div>';
    document.querySelectorAll(".queue-card").forEach(card => card.addEventListener("click", () => { state.selectedParty = Number(card.dataset.partyId); renderQueue(); renderRecommendation(); }));
    renderRecommendation();
  }
  function renderRecommendation() {
    const recommendations = state.snapshot?.recommendations || [];
    const rec = recommendations.find(row => row.party_id === state.selectedParty) || recommendations[0];
    const party = state.snapshot?.parties.find(row => row.id === rec?.party_id);
    const el = $("recommendation-card");
    if (!rec || !party) { el.innerHTML = ""; return; }
    el.innerHTML = `<strong>Recommended for ${escapeHtml(party.guest_name)}</strong><p>${rec.table_number ? `Table ${escapeHtml(rec.table_number)}` : "No table yet"}${rec.server_employee_id ? ` · next server #${rec.server_employee_id}` : ""}</p><p>${escapeHtml(rec.reason)}</p>${rec.table_number ? `<button class="primary compact" data-seat-recommendation type="button">Review seating</button>` : ""}`;
    el.querySelector("[data-seat-recommendation]")?.addEventListener("click", () => openSeat(rec.table_number, party.id, rec.server_employee_id));
  }

  function tableState(number) { return state.snapshot?.table_states.find(row => String(row.table_number) === String(number)) || { status: "AVAILABLE", party_id: null }; }
  function partyById(id) { return state.snapshot?.parties.find(row => row.id === Number(id)); }
  function renderFloor() {
    const canvas = $("floor-canvas"), layout = state.snapshot?.layout;
    if (!layout) { canvas.innerHTML = '<div class="empty-copy">Open a service to load the floor.</div>'; return; }
    canvas.style.width = `${layout.canvas_width}px`; canvas.style.height = `${layout.canvas_height}px`; canvas.style.transform = `scale(${state.zoom})`;
    $("floor-title").textContent = `${layout.name} · v${layout.version}`; $("zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
    const areas = (layout.areas || []).map(area => `<div class="floor-area shape-${String(area.shape || "RECTANGLE").toLowerCase()}" style="left:${area.x || 0}px;top:${area.y || 0}px;width:${area.width || 300}px;height:${area.height || 220}px"><span>${escapeHtml(area.name || "Dining area")}</span></div>`).join("");
    const fixtures = (layout.fixtures || []).filter(fixture => fixture.type === "TEXT").map(fixture => `<div class="floor-fixture" style="left:${fixture.x || 0}px;top:${fixture.y || 0}px;width:${fixture.width || 120}px;height:${fixture.height || 72}px"><span>${escapeHtml(fixture.text || "")}</span></div>`).join("");
    const tables = (layout.tables || []).map(table => {
      const current = tableState(table.table_number), party = partyById(current.party_id), status = String(current.status).toLowerCase();
      return `<button class="floor-table ${status} ${String(table.shape).toLowerCase()}${state.selectedTable === table.table_number ? " selected" : ""}" data-table-number="${escapeHtml(table.table_number)}" style="left:${table.x}px;top:${table.y}px;width:${table.width}px;height:${table.height}px;transform:rotate(${table.rotation}deg)" aria-label="Table ${escapeHtml(table.label)}, ${status}"><strong>${escapeHtml(table.label)}</strong><small>${party ? `${escapeHtml(party.guest_name)} · ${party.party_size}` : `${table.capacity} seats`}</small>${party?.seated_at ? `<span class="table-timer">${minutesSince(party.seated_at)}m</span>` : ""}</button>`;
    }).join("");
    canvas.innerHTML = areas + fixtures + tables;
    canvas.querySelectorAll(".floor-table").forEach(button => button.addEventListener("click", () => selectTable(button.dataset.tableNumber)));
  }
  function selectTable(number) {
    state.selectedTable = number; const current = tableState(number);
    renderFloor(); renderDetail();
    if (current.status === "AVAILABLE" && activeQueue().length) openSeat(number, state.selectedParty);
  }

  function renderDetail() {
    const el = $("table-detail"), number = state.selectedTable;
    if (!number || !state.snapshot) { el.className = "empty-detail"; el.innerHTML = "<span>Select a table</span><p>Seat a party, review timing, change dining stage, move, or clear the table.</p>"; return; }
    const definition = state.snapshot.layout.tables.find(row => String(row.table_number) === String(number));
    const current = tableState(number), party = partyById(current.party_id);
    el.className = "detail-card";
    if (!party) {
      el.innerHTML = `<span class="eyebrow">${escapeHtml(current.status)}</span><h3>Table ${escapeHtml(definition.label)}</h3><div class="detail-meta"><div><span>Capacity</span><strong>${definition.capacity}</strong></div><div><span>Section</span><strong>${escapeHtml(definition.section_name || "Unassigned")}</strong></div></div><div class="detail-actions"><button class="primary wide" data-seat-table>Seat party</button><button data-table-status="HELD">Hold</button><button data-table-status="BLOCKED">Block</button>${current.status !== "AVAILABLE" ? '<button data-table-status="AVAILABLE">Mark available</button>' : ""}</div>`;
      el.querySelector("[data-seat-table]")?.addEventListener("click", () => openSeat(number));
      el.querySelectorAll("[data-table-status]").forEach(button => button.addEventListener("click", () => command("SET_TABLE_STATUS", { table_numbers: [number], status: button.dataset.tableStatus })));
      return;
    }
    el.innerHTML = `<span class="eyebrow">${escapeHtml(party.dining_stage || "Seated")}</span><h3>${escapeHtml(party.guest_name)} · ${party.party_size}</h3><p>Table ${escapeHtml(number)} · seated ${minutesSince(party.seated_at)} minutes</p><div class="detail-meta"><div><span>Server</span><strong>${party.server_employee_id ? `#${party.server_employee_id}` : "Unassigned"}</strong></div><div><span>Source</span><strong>${escapeHtml(party.source.replaceAll("_", " "))}</strong></div></div><div class="detail-actions"><button data-stage="ORDERED">Ordered</button><button data-stage="ENTREES">Entrées</button><button data-stage="CHECK_DROPPED">Check dropped</button><button data-move-party>Move</button><button data-combine-party>Combine tables</button><button class="danger" data-clear-party>Clear table</button></div>`;
    el.querySelectorAll("[data-stage]").forEach(button => button.addEventListener("click", () => command("ADVANCE_STAGE", { party_id: party.id, dining_stage: button.dataset.stage })));
    el.querySelector("[data-move-party]")?.addEventListener("click", () => openTransfer("MOVE", party));
    el.querySelector("[data-combine-party]")?.addEventListener("click", () => openTransfer("COMBINE", party));
    el.querySelector("[data-clear-party]")?.addEventListener("click", () => { if (confirm(`Clear ${party.guest_name} from Table ${number}?`)) command("CLEAR", { party_id: party.id }); });
  }

  function renderRotation() {
    const rows = state.snapshot?.rotation || [];
    $("rotation-list").innerHTML = rows.length ? rows.map(row => `<div class="rotation-row"><div><strong>${escapeHtml(row.employee_name)}</strong><span>${escapeHtml(row.section_name || "Open floor")} · ${row.turns} turns · ${row.covers} covers</span></div><div class="rotation-actions"><b>${row.paused ? "Paused" : row.last_sat_at ? `${minutesSince(row.last_sat_at)}m` : "Next"}</b><button data-pause-server="${row.employee_id}" data-paused="${row.paused ? "false" : "true"}">${row.paused ? "Resume" : "Pause"}</button></div></div>`).join("") : '<div class="empty-copy">Add servers from today’s TeamSheet or service settings.</div>';
    $("rotation-list").querySelectorAll("[data-pause-server]").forEach(button => button.addEventListener("click", () => command("PAUSE_SERVER", { server_employee_id: Number(button.dataset.pauseServer), paused: button.dataset.paused === "true" })));
  }

  function renderLists() {
    const parties = state.snapshot?.parties || [];
    const waitlist = parties.filter(p => p.source !== "RESERVATION"), reservations = parties.filter(p => p.source === "RESERVATION");
    $("waitlist-table").innerHTML = renderPartyRows(waitlist, false);
    $("reservation-table").innerHTML = renderPartyRows(reservations, true);
    document.querySelectorAll("[data-party-arrived]").forEach(button => button.addEventListener("click", () => updateParty(Number(button.dataset.partyArrived), "ARRIVED")));
    document.querySelectorAll("[data-party-notify]").forEach(button => button.addEventListener("click", () => command("NOTIFY", { party_id: Number(button.dataset.partyNotify) })));
    document.querySelectorAll("[data-party-seat]").forEach(button => button.addEventListener("click", () => openSeat(null, Number(button.dataset.partySeat))));
    document.querySelectorAll("[data-party-cancel]").forEach(button => button.addEventListener("click", () => updateParty(Number(button.dataset.partyCancel), "CANCELLED")));
  }
  function renderPartyRows(rows, reservations) {
    if (!rows.length) return `<div class="empty-copy">No ${reservations ? "reservations" : "waitlist parties"} for this service.</div>`;
    return rows.map(party => `<article class="data-row"><div><span class="mobile-label">Guest</span><strong>${escapeHtml(party.guest_name)}</strong><small>${escapeHtml(party.notes || "No notes")}</small></div><div><span class="mobile-label">Party</span>${party.party_size} guests</div><div><span class="mobile-label">${reservations ? "Time" : "Quote"}</span>${reservations ? formatTime(party.reservation_at) : `${party.quoted_minutes ?? 0} min`}</div><div><span class="mobile-label">Contact</span>${escapeHtml(party.phone || "—")}</div><div><span class="mobile-label">Status</span><span class="status-pill">${escapeHtml(partyStatus(party))}</span></div><div class="row-actions">${!["ARRIVED", "SEATED", "COMPLETED", "CANCELLED"].includes(party.status) ? `<button data-party-arrived="${party.id}">Arrived</button>` : ""}${party.sms_consent && party.phone && ["WAITING", "ARRIVED"].includes(party.status) ? `<button data-party-notify="${party.id}">Notify</button>` : ""}${["WAITING", "NOTIFIED", "ARRIVED", "BOOKED", "CONFIRMED"].includes(party.status) ? `<button class="primary" data-party-seat="${party.id}">Seat</button><button class="danger" data-party-cancel="${party.id}">Cancel</button>` : ""}</div></article>`).join("");
  }

  function renderPacing() {
    const parties = state.snapshot?.parties || [], now = Date.now(), buckets = Array.from({ length: 8 }, (_, index) => ({ at: new Date(now + index * 15 * 60000), covers: 0 }));
    parties.filter(p => p.source === "RESERVATION" && p.reservation_at && !["CANCELLED", "NO_SHOW"].includes(p.status)).forEach(party => { const index = Math.floor((new Date(party.reservation_at).getTime() - now) / (15 * 60000)); if (buckets[index]) buckets[index].covers += Number(party.party_size); });
    $("pacing-chart").innerHTML = buckets.map(bucket => `<div class="pacing-bar"><strong>${bucket.covers}</strong><i style="height:${Math.max(4, bucket.covers * 12)}px"></i><span>${bucket.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>`).join("");
    $("pacing-servers").innerHTML = (state.snapshot?.rotation || []).map(row => `<div class="rotation-row"><div><strong>${escapeHtml(row.employee_name)}</strong><span>${row.turns} turns</span></div><b>${row.covers} covers</b></div>`).join("") || '<div class="empty-copy">No server rotation configured.</div>';
    const values = metrics(), alerts = [];
    if (values.waiting > values.available) alerts.push("More parties are waiting than tables currently available.");
    (state.snapshot?.parties || []).filter(p => p.status === "SEATED" && minutesSince(p.seated_at) > 90).forEach(p => alerts.push(`${p.guest_name} has been seated for ${minutesSince(p.seated_at)} minutes.`));
    if (!alerts.length) alerts.push("No immediate pacing risks detected.");
    $("pacing-alerts").innerHTML = alerts.map(alert => `<div class="alert-row">${escapeHtml(alert)}</div>`).join("");
  }

  async function loadRotationOptions() {
    if (!state.service) { state.rotationOptions = null; renderRotationSetup(); return; }
    state.rotationOptions = await api(`/agm/services/${state.service.id}/rotation`);
    renderRotationSetup();
  }
  function renderRotationSetup() {
    const el = $("rotation-options"); if (!el) return;
    const candidates = state.rotationOptions?.candidates || [];
    const currentIds = new Set((state.snapshot?.rotation || []).map(row => Number(row.employee_id)));
    el.className = "rotation-options";
    el.innerHTML = candidates.length ? candidates.map(row => `<label class="rotation-option"><input type="checkbox" value="${row.employee_id}" data-section="${escapeHtml(row.section_name || "")}" ${currentIds.has(Number(row.employee_id)) || (!currentIds.size && Boolean(row.from_team_sheet)) ? "checked" : ""}><span>${escapeHtml(row.employee_name)}<small>${escapeHtml(row.section_name || (row.from_team_sheet ? "Today’s TeamSheet" : "Available server"))}</small></span></label>`).join("") : '<div class="empty-copy">No active servers are available. Add employees or publish today’s TeamSheet first.</div>';
    $("save-rotation-btn").disabled = !state.service;
    $("close-service-btn").disabled = !state.service || state.service.status !== "OPEN";
  }
  async function saveRotation() {
    if (!state.service) return toast("Open a service first.", true);
    const rows = Array.from($("rotation-options").querySelectorAll("input:checked")).map(input => ({ employee_id: Number(input.value), section_name: input.dataset.section || null }));
    await post(`/agm/services/${state.service.id}/rotation`, rows); await refreshService(); await loadRotationOptions(); toast("Server rotation saved.");
  }
  async function closeService() {
    if (!state.service || !confirm("Close this service? All seated parties must be cleared first.")) return;
    await command("CLOSE_SERVICE"); await loadServices(); toast("Service closed.");
  }

  async function updateParty(id, status) {
    const party = partyById(id); if (!party) return;
    try { await patch(`/agm/parties/${id}`, { revision: party.revision, status }); await refreshService(); toast(`Party marked ${status.toLowerCase()}.`); } catch (error) { showError(error); }
  }

  async function command(type, data = {}) {
    if (!state.service) return toast("Open a service first.", true);
    setSync("Saving");
    try {
      const result = await post(`/agm/services/${state.service.id}/commands`, { command_id: uuid(), expected_revision: Number(state.service.revision), type, table_numbers: [], ...data });
      state.service.revision = result.service_revision;
      await refreshService(); toast(type === "NOTIFY" ? "Message queued; provider configuration is still required." : "Floor updated.");
    } catch (error) {
      if (error.status === 409) await refreshService().catch(() => {});
      showError(error);
    }
  }
  async function refreshService() { if (state.service) await loadService(state.service.id); }

  function openParty(source) {
    if (!state.service) return toast("Open a service before adding parties.", true);
    $("party-form").reset(); $("party-source").value = source; $("party-size").value = 2;
    $("party-dialog-title").textContent = source === "RESERVATION" ? "New reservation" : "Add to waitlist";
    $("party-dialog-eyebrow").textContent = source === "RESERVATION" ? "Staff-managed booking" : "Walk-in party";
    $("reservation-time-field").classList.toggle("hidden", source !== "RESERVATION");
    if (source === "RESERVATION") $("party-reservation-at").value = `${$("service-date").value}T18:00`;
    $("party-dialog").showModal();
  }
  async function saveParty() {
    const source = $("party-source").value;
    const payload = { guest_name: $("party-name").value.trim(), phone: $("party-phone").value.trim() || null, party_size: Number($("party-size").value), source, reservation_at: source === "RESERVATION" ? ($("party-reservation-at").value || null) : null, quoted_minutes: Number($("party-quote").value) || null, notes: $("party-notes").value.trim() || null, sms_consent: $("party-sms-consent").checked };
    if (!payload.guest_name) return toast("Guest name is required.", true);
    await post(`/agm/services/${state.service.id}/parties`, payload); $("party-dialog").close(); await refreshService(); toast("Party added.");
  }

  function openSeat(tableNumber = null, partyId = null, serverId = null) {
    if (!state.service) return;
    const availableTables = state.snapshot.layout.tables.filter(table => tableState(table.table_number).status === "AVAILABLE");
    const queue = activeQueue(); if (!queue.length) return toast("Add or arrive a party before seating.", true);
    const selected = tableNumber || state.selectedTable || availableTables[0]?.table_number;
    if (!selected) return toast("No available table can be selected.", true);
    state.seatMode = "SEAT"; state.seatExistingTables = []; state.selectedTable = selected;
    $("seat-dialog-title").textContent = "Seat party";
    $("confirm-seat-btn").textContent = "Confirm seating";
    $("seat-summary").textContent = "Review the advisory recommendation, then confirm the party, table, and server.";
    $("seat-party").innerHTML = queue.map(party => `<option value="${party.id}">${escapeHtml(party.guest_name)} · ${party.party_size} guests</option>`).join("");
    $("seat-party").disabled = false; if (partyId) $("seat-party").value = String(partyId);
    $("seat-table").innerHTML = availableTables.map(table => `<option value="${escapeHtml(table.table_number)}">Table ${escapeHtml(table.label)} · ${table.capacity} seats</option>`).join("");
    $("seat-table").value = String(selected);
    $("seat-server").innerHTML = '<option value="">Unassigned</option>' + (state.snapshot.rotation || []).filter(row => !row.paused).map(row => `<option value="${row.employee_id}">${escapeHtml(row.employee_name)} · ${row.covers} covers</option>`).join("");
    if (serverId) $("seat-server").value = String(serverId); $("seat-dialog").showModal();
  }
  function openTransfer(mode, party) {
    const availableTables = state.snapshot.layout.tables.filter(table => tableState(table.table_number).status === "AVAILABLE");
    if (!availableTables.length) return toast(`No available table is ready to ${mode === "MOVE" ? "move to" : "combine"}.`, true);
    state.seatMode = mode; state.seatExistingTables = Array.isArray(party.table_numbers) ? party.table_numbers.map(String) : [];
    $("seat-dialog-title").textContent = mode === "MOVE" ? "Move party" : "Combine tables";
    $("confirm-seat-btn").textContent = mode === "MOVE" ? "Confirm move" : "Confirm combination";
    $("seat-summary").textContent = mode === "MOVE" ? `Move ${party.guest_name} from Table ${state.seatExistingTables.join(" + ")}.` : `Add one available table to ${state.seatExistingTables.join(" + ")}.`;
    $("seat-party").innerHTML = `<option value="${party.id}">${escapeHtml(party.guest_name)} · ${party.party_size} guests</option>`; $("seat-party").disabled = true;
    $("seat-table").innerHTML = availableTables.map(table => `<option value="${escapeHtml(table.table_number)}">Table ${escapeHtml(table.label)} · ${table.capacity} seats</option>`).join("");
    $("seat-server").innerHTML = '<option value="">Unassigned</option>' + (state.snapshot.rotation || []).map(row => `<option value="${row.employee_id}">${escapeHtml(row.employee_name)} · ${row.covers} covers</option>`).join("");
    if (party.server_employee_id) $("seat-server").value = String(party.server_employee_id);
    $("seat-dialog").showModal();
  }
  async function confirmSeat() {
    const partyId = Number($("seat-party").value), serverId = Number($("seat-server").value) || null, target = $("seat-table").value;
    const tableNumbers = state.seatMode === "COMBINE" ? [...new Set([...state.seatExistingTables, target])] : [target];
    await command(state.seatMode, { party_id: partyId, table_numbers: tableNumbers, server_employee_id: serverId }); $("seat-dialog").close(); $("seat-party").disabled = false;
  }

  async function openServiceDialog() {
    await loadLayouts(); const published = state.layouts.filter(layout => layout.status === "PUBLISHED");
    if (!published.length) { switchView("layouts"); return toast("Publish a layout before opening service.", true); }
    $("service-layout").innerHTML = published.map(layout => `<option value="${layout.id}">${escapeHtml(layout.name)} · v${layout.version}</option>`).join(""); $("service-dialog").showModal();
  }
  async function createService() {
    const created = await post(`/agm/stores/${state.storeId}/services`, { layout_id: Number($("service-layout").value), service_date: $("service-date").value, name: $("service-name").value.trim() || "Dinner", starts_at: $("service-start").value || null, ends_at: $("service-end").value || null });
    $("service-dialog").close(); await loadServices(); $("service-select").value = String(created.id); await loadService(created.id); toast("Service opened.");
  }

  function renderLayoutList() {
    $("layout-list").innerHTML = state.layouts.length ? state.layouts.map(layout => `<button class="layout-item${state.editorLayout?.id === layout.id ? " active" : ""}" data-layout-id="${layout.id}"><strong>${escapeHtml(layout.name)}</strong><span>v${layout.version} · ${escapeHtml(layout.status)}</span></button>`).join("") : '<div class="empty-copy">No layouts yet. Create the first floor.</div>';
    document.querySelectorAll("[data-layout-id]").forEach(button => button.addEventListener("click", () => loadEditorLayout(Number(button.dataset.layoutId))));
  }
  function newLayout() {
    state.editorLayout = { id: null, name: "Main Floor", version: 1, revision: 1, status: "DRAFT", canvas_width: 1200, canvas_height: 760, areas: [{ name: "Main dining", shape: "ROUNDED", x: 36, y: 36, width: 760, height: 540 }], fixtures: [] };
    state.editorTables = Array.from({ length: 6 }, (_, i) => ({ table_number: String(i + 1), label: String(i + 1), capacity: i % 3 === 0 ? 6 : 4, shape: i % 2 ? "SQUARE" : "ROUND", x: 100 + (i % 3) * 190, y: 120 + Math.floor(i / 3) * 210, width: 88, height: 88, rotation: 0, area_name: "Main dining", section_name: "", combinable_with: [] }));
    state.editorFixtures = []; state.editorSelected = null; state.editorSelectedTables = new Set(); state.editorFixtureSelected = null; state.copiedTable = null; renderEditor(); renderLayoutList();
  }
  async function loadEditorLayout(id) {
    state.editorLayout = await api(`/agm/layouts/${id}`); state.editorTables = state.editorLayout.tables.map(row => ({ ...row })); state.editorFixtures = (state.editorLayout.fixtures || []).map(row => ({ ...row })); state.editorSelected = null; state.editorSelectedTables = new Set(); state.editorFixtureSelected = null; state.copiedTable = null; renderEditor(); renderLayoutList();
  }
  function renderEditor() {
    const layout = state.editorLayout; if (!layout) return;
    $("layout-name").value = layout.name; const canvas = $("editor-canvas"); canvas.style.width = `${layout.canvas_width}px`; canvas.style.height = `${layout.canvas_height}px`;
    const areas = (layout.areas || []).map(area => `<div class="floor-area shape-${String(area.shape || "RECTANGLE").toLowerCase()}" style="left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px"><span>${escapeHtml(area.name)}</span></div>`).join("");
    const fixtures = state.editorFixtures.map((fixture, index) => `<div class="editor-fixture${state.editorFixtureSelected === index ? " selected" : ""}" data-fixture-index="${index}" style="left:${fixture.x}px;top:${fixture.y}px;width:${fixture.width || 120}px;height:${fixture.height || 72}px" tabindex="0"><span>${escapeHtml(fixture.text || "Text block")}</span><button class="delete-table" data-delete-fixture="${index}" aria-label="Delete text block">×</button></div>`).join("");
    canvas.innerHTML = areas + fixtures + state.editorTables.map((table, index) => `<div class="floor-table editor-table ${String(table.shape).toLowerCase()}${state.editorSelectedTables.has(index) ? " selected" : ""}" data-editor-index="${index}" style="left:${table.x}px;top:${table.y}px;width:${table.width}px;height:${table.height}px;transform:rotate(${table.rotation || 0}deg)" tabindex="0"><strong>${escapeHtml(table.label || table.table_number)}</strong><small>Table ${escapeHtml(table.table_number)} · ${table.capacity} seats</small><button class="delete-table" data-delete-index="${index}" aria-label="Delete table ${escapeHtml(table.table_number)}">×</button></div>`).join("");
    canvas.querySelectorAll(".editor-table").forEach(table => bindEditorDrag(table, "table"));
    canvas.querySelectorAll(".editor-fixture").forEach(fixture => bindEditorDrag(fixture, "fixture"));
    canvas.querySelectorAll("[data-delete-index]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); const removed = Number(button.dataset.deleteIndex); state.editorTables.splice(removed, 1); state.editorSelectedTables = new Set([...state.editorSelectedTables].filter(index => index !== removed).map(index => index > removed ? index - 1 : index)); state.editorSelected = state.editorSelectedTables.size === 1 ? [...state.editorSelectedTables][0] : null; renderEditor(); }));
    canvas.querySelectorAll("[data-delete-fixture]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); state.editorFixtures.splice(Number(button.dataset.deleteFixture), 1); state.editorFixtureSelected = null; renderEditor(); }));
    $("save-layout-btn").disabled = layout.status !== "DRAFT"; $("publish-layout-btn").disabled = layout.status !== "DRAFT";
    $("add-table-btn").disabled = layout.status !== "DRAFT"; $("add-text-block-btn").disabled = layout.status !== "DRAFT"; bindSelectionMarquee(canvas); renderEditorControls();
  }
  function renderEditorControls() {
    const draft = state.editorLayout?.status === "DRAFT", selectedCount = state.editorSelectedTables.size, table = selectedCount === 1 ? state.editorTables[state.editorSelected] : null, fixture = state.editorFixtures[state.editorFixtureSelected], area = state.editorLayout?.areas?.[0];
    $("selected-table-label").textContent = selectedCount > 1 ? `${selectedCount} tables selected` : "Selected table";
    [["table-number", table?.table_number], ["table-label", table?.label], ["table-shape", table?.shape], ["table-capacity", table?.capacity]].forEach(([id, value]) => { const input = $(id); input.disabled = !draft || !table; if (value !== undefined) input.value = value; else if (id !== "table-shape" && id !== "table-capacity") input.value = ""; });
    $("fixture-text").disabled = !draft || !fixture; $("fixture-text").value = fixture?.text || "";
    $("duplicate-table-btn").disabled = !draft || !table;
    [["area-name", area?.name], ["area-shape", area?.shape || "RECTANGLE"], ["area-width", area?.width], ["area-height", area?.height]].forEach(([id, value]) => { $(id).disabled = !draft || !area; if (value !== undefined) $(id).value = value; });
  }
  function syncEditorSelection(canvas = $("editor-canvas")) {
    canvas.querySelectorAll(".editor-table").forEach(row => row.classList.toggle("selected", state.editorSelectedTables.has(Number(row.dataset.editorIndex))));
    canvas.querySelectorAll(".editor-fixture").forEach(row => row.classList.toggle("selected", Number(row.dataset.fixtureIndex) === state.editorFixtureSelected));
    renderEditorControls();
  }
  function bindEditorDrag(element, type) {
    element.addEventListener("pointerdown", event => {
      if (event.target.closest("button") || state.editorLayout?.status !== "DRAFT") return;
      event.preventDefault(); const canvas = element.parentElement, index = Number(type === "table" ? element.dataset.editorIndex : element.dataset.fixtureIndex), additive = event.ctrlKey || event.metaKey;
      if (type === "fixture") {
        state.editorSelectedTables = new Set(); state.editorSelected = null; state.editorFixtureSelected = index; syncEditorSelection(canvas);
        const fixture = state.editorFixtures[index], startX = event.clientX, startY = event.clientY, originX = fixture.x, originY = fixture.y; element.setPointerCapture?.(event.pointerId);
        const moveFixture = moveEvent => { fixture.x = Math.max(0, Math.round((originX + moveEvent.clientX - startX) / 12) * 12); fixture.y = Math.max(0, Math.round((originY + moveEvent.clientY - startY) / 12) * 12); element.style.left = `${fixture.x}px`; element.style.top = `${fixture.y}px`; };
        const stopFixture = () => { element.removeEventListener("pointermove", moveFixture); element.removeEventListener("pointerup", stopFixture); element.removeEventListener("pointercancel", stopFixture); };
        element.addEventListener("pointermove", moveFixture); element.addEventListener("pointerup", stopFixture); element.addEventListener("pointercancel", stopFixture); return;
      }
      if (additive && state.editorSelectedTables.has(index)) {
        state.editorSelectedTables.delete(index); state.editorSelected = state.editorSelectedTables.size === 1 ? [...state.editorSelectedTables][0] : null; syncEditorSelection(canvas); return;
      }
      if (additive) state.editorSelectedTables.add(index); else if (!state.editorSelectedTables.has(index)) state.editorSelectedTables = new Set([index]);
      state.editorSelected = state.editorSelectedTables.size === 1 ? [...state.editorSelectedTables][0] : null; state.editorFixtureSelected = null; syncEditorSelection(canvas);
      const selected = [...state.editorSelectedTables], origins = selected.map(tableIndex => ({ tableIndex, x: state.editorTables[tableIndex].x, y: state.editorTables[tableIndex].y }));
      const minX = Math.min(...origins.map(row => row.x)), minY = Math.min(...origins.map(row => row.y));
      const maxRight = Math.max(...origins.map(row => row.x + state.editorTables[row.tableIndex].width)), maxBottom = Math.max(...origins.map(row => row.y + state.editorTables[row.tableIndex].height));
      const startX = event.clientX, startY = event.clientY; element.setPointerCapture?.(event.pointerId);
      const moveGroup = moveEvent => {
        const rawX = Math.round((moveEvent.clientX - startX) / 12) * 12, rawY = Math.round((moveEvent.clientY - startY) / 12) * 12;
        const deltaX = Math.max(-minX, Math.min(state.editorLayout.canvas_width - maxRight, rawX)), deltaY = Math.max(-minY, Math.min(state.editorLayout.canvas_height - maxBottom, rawY));
        origins.forEach(origin => { const table = state.editorTables[origin.tableIndex]; table.x = origin.x + deltaX; table.y = origin.y + deltaY; const row = canvas.querySelector(`[data-editor-index="${origin.tableIndex}"]`); if (row) { row.style.left = `${table.x}px`; row.style.top = `${table.y}px`; } });
      };
      const stopGroup = () => { element.removeEventListener("pointermove", moveGroup); element.removeEventListener("pointerup", stopGroup); element.removeEventListener("pointercancel", stopGroup); };
      element.addEventListener("pointermove", moveGroup); element.addEventListener("pointerup", stopGroup); element.addEventListener("pointercancel", stopGroup);
    });
  }
  function bindSelectionMarquee(canvas) {
    canvas.addEventListener("pointerdown", event => {
      if (event.target !== canvas || state.editorLayout?.status !== "DRAFT") return;
      event.preventDefault(); const bounds = canvas.getBoundingClientRect(), startX = Math.max(0, event.clientX - bounds.left), startY = Math.max(0, event.clientY - bounds.top), additive = event.ctrlKey || event.metaKey;
      const baseSelection = additive ? new Set(state.editorSelectedTables) : new Set(), marquee = document.createElement("div"); marquee.className = "selection-marquee"; marquee.style.left = `${startX}px`; marquee.style.top = `${startY}px`; canvas.appendChild(marquee); canvas.setPointerCapture?.(event.pointerId); let moved = false;
      const moveMarquee = moveEvent => {
        const currentX = Math.max(0, Math.min(state.editorLayout.canvas_width, moveEvent.clientX - bounds.left)), currentY = Math.max(0, Math.min(state.editorLayout.canvas_height, moveEvent.clientY - bounds.top));
        const left = Math.min(startX, currentX), top = Math.min(startY, currentY), right = Math.max(startX, currentX), bottom = Math.max(startY, currentY); moved = moved || Math.abs(currentX - startX) > 3 || Math.abs(currentY - startY) > 3;
        marquee.style.left = `${left}px`; marquee.style.top = `${top}px`; marquee.style.width = `${right - left}px`; marquee.style.height = `${bottom - top}px`;
        const selected = new Set(baseSelection); state.editorTables.forEach((table, index) => { if (table.x < right && table.x + table.width > left && table.y < bottom && table.y + table.height > top) selected.add(index); });
        state.editorSelectedTables = selected; state.editorSelected = selected.size === 1 ? [...selected][0] : null; state.editorFixtureSelected = null; syncEditorSelection(canvas);
      };
      const stopMarquee = () => { if (!moved && !additive) { state.editorSelectedTables = new Set(); state.editorSelected = null; state.editorFixtureSelected = null; syncEditorSelection(canvas); } marquee.remove(); canvas.removeEventListener("pointermove", moveMarquee); canvas.removeEventListener("pointerup", stopMarquee); canvas.removeEventListener("pointercancel", stopMarquee); };
      canvas.addEventListener("pointermove", moveMarquee); canvas.addEventListener("pointerup", stopMarquee); canvas.addEventListener("pointercancel", stopMarquee);
    });
  }
  function addEditorTable() {
    if (!state.editorLayout) newLayout(); const next = state.editorTables.reduce((max, row) => Math.max(max, Number(row.table_number) || 0), 0) + 1;
    state.editorTables.push({ table_number: String(next), label: String(next), capacity: 4, shape: "ROUND", x: 72, y: 72, width: 88, height: 88, rotation: 0, area_name: state.editorLayout.areas?.[0]?.name || "Main dining", section_name: "", combinable_with: [] }); state.editorSelected = state.editorTables.length - 1; state.editorSelectedTables = new Set([state.editorSelected]); state.editorFixtureSelected = null; renderEditor();
  }
  function incrementTableNumber(source) {
    const value = String(source || "").trim(), match = /^(.*?)(\d+)$/.exec(value); let prefix = value, number = 1, width = 0;
    if (match) { prefix = match[1]; number = Number(match[2]); width = match[2].length; }
    const used = new Set(state.editorTables.map(table => String(table.table_number).trim().toLowerCase())); let candidate;
    do { number += 1; const suffix = width ? String(number).padStart(width, "0") : String(number); candidate = `${prefix}${suffix}`; } while (used.has(candidate.toLowerCase()));
    return candidate;
  }
  function copySelectedTable(showNotice = true) {
    const table = state.editorTables[state.editorSelected]; if (!table || state.editorLayout?.status !== "DRAFT") return false;
    const { id, layout_id, created_at, updated_at, ...copy } = table; state.copiedTable = JSON.parse(JSON.stringify(copy));
    if (showNotice) toast(`Table ${table.table_number} copied.`); return true;
  }
  function pasteCopiedTable() {
    if (!state.copiedTable || state.editorLayout?.status !== "DRAFT") return toast("Copy a table before pasting.", true);
    const nextNumber = incrementTableNumber(state.copiedTable.table_number), layout = state.editorLayout, clone = JSON.parse(JSON.stringify(state.copiedTable));
    clone.table_number = nextNumber; clone.label = nextNumber; clone.x = Math.min(Math.max(0, layout.canvas_width - clone.width), Number(clone.x) + 24); clone.y = Math.min(Math.max(0, layout.canvas_height - clone.height), Number(clone.y) + 24); clone.combinable_with = [];
    state.editorTables.push(clone); state.editorSelected = state.editorTables.length - 1; state.editorSelectedTables = new Set([state.editorSelected]); state.editorFixtureSelected = null; state.copiedTable = JSON.parse(JSON.stringify(clone)); renderEditor(); toast(`Created Table ${nextNumber}.`);
  }
  function duplicateSelectedTable() { if (copySelectedTable(false)) pasteCopiedTable(); }
  function addTextBlock() {
    if (!state.editorLayout) newLayout(); state.editorFixtures.push({ type: "TEXT", text: "Host stand", x: 72, y: 72, width: 96, height: 96 }); state.editorFixtureSelected = state.editorFixtures.length - 1; state.editorSelected = null; state.editorSelectedTables = new Set(); renderEditor();
  }
  function updateSelectedTable(shouldRender = true) {
    const table = state.editorTables[state.editorSelected]; if (!table) return;
    table.table_number = $("table-number").value.trim() || table.table_number; table.label = $("table-label").value.trim() || table.table_number; table.capacity = Math.min(40, Math.max(1, Number($("table-capacity").value) || table.capacity)); table.shape = $("table-shape").value;
    table.width = table.shape === "RECTANGLE" || table.shape === "BAR" ? 132 : 88; table.height = table.shape === "BAR" ? 64 : 88;
    if (shouldRender) renderEditor(); else { const selected = $("editor-canvas").querySelector(".editor-table.selected"); if (selected) { selected.querySelector("strong").textContent = table.label; selected.querySelector("small").textContent = `Table ${table.table_number} · ${table.capacity} seats`; } }
  }
  function updateArea(shouldRender = true) {
    const area = state.editorLayout?.areas?.[0]; if (!area) return;
    area.name = $("area-name").value.trim() || "Main dining"; area.shape = $("area-shape").value; area.width = Math.min(5000, Math.max(160, Number($("area-width").value) || area.width)); area.height = Math.min(5000, Math.max(160, Number($("area-height").value) || area.height));
    if (area.shape === "CIRCLE") { area.height = area.width; $("area-height").value = area.height; }
    if (shouldRender) renderEditor(); else { const floor = $("editor-canvas").querySelector(".floor-area"); if (floor) { floor.style.width = `${area.width}px`; floor.style.height = `${area.height}px`; floor.querySelector("span").textContent = area.name; } }
  }
  function updateTextBlock(shouldRender = true) { const fixture = state.editorFixtures[state.editorFixtureSelected]; if (!fixture) return; fixture.text = $("fixture-text").value.trim() || "Text block"; if (shouldRender) renderEditor(); else { const label = $("editor-canvas").querySelector(".editor-fixture.selected>span"); if (label) label.textContent = fixture.text; } }
  async function saveLayout() {
    if (!state.editorLayout) return;
    const numbers = state.editorTables.map(table => String(table.table_number).trim().toLowerCase()); if (new Set(numbers).size !== numbers.length) return toast("Table numbers must be unique.", true);
    const payload = { name: $("layout-name").value.trim() || "Main Floor", canvas_width: state.editorLayout.canvas_width, canvas_height: state.editorLayout.canvas_height, areas: state.editorLayout.areas || [], fixtures: state.editorFixtures, tables: state.editorTables.map(({ id, layout_id, created_at, updated_at, ...table }) => table) };
    const saved = state.editorLayout.id ? await put(`/agm/layouts/${state.editorLayout.id}`, { ...payload, revision: state.editorLayout.revision }) : await post(`/agm/stores/${state.storeId}/layouts`, payload);
    state.editorLayout = saved; state.editorTables = saved.tables; state.editorFixtures = (saved.fixtures || []).map(row => ({ ...row })); await loadLayouts(true); renderEditor(); toast("Layout draft saved.");
  }
  async function publishLayout() { if (!state.editorLayout?.id) await saveLayout(); const published = await post(`/agm/layouts/${state.editorLayout.id}/publish`, {}); state.editorLayout = published; state.editorTables = published.tables; state.editorFixtures = (published.fixtures || []).map(row => ({ ...row })); await loadLayouts(true); renderEditor(); toast("Layout published for future services."); }

  function connectEvents() {
    state.socket?.close(); if (!state.service || !window.WebSocket) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"; const socket = new WebSocket(`${protocol}//${location.host}/agm/services/${state.service.id}/events`); state.socket = socket;
    socket.onopen = () => setSync("Live", "connected"); socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "service_event" && Number(message.revision) > Number(state.service.revision)) refreshService(); } catch {} };
    socket.onclose = () => { if (state.service) { setSync("Polling", "connected"); setTimeout(() => state.service && connectEvents(), 10000); } }; socket.onerror = () => setSync("Polling", "connected");
  }
  function showError(error) { console.error(error); setSync("Needs attention", "error"); notice(error.message || "Something went wrong.", true); toast(error.message || "Something went wrong.", true); }

  document.querySelectorAll(".workspace-tabs button").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.querySelectorAll("[data-open-party]").forEach(button => button.addEventListener("click", () => openParty(button.dataset.openParty)));
  $("store-select").addEventListener("change", async () => { state.storeId = Number($("store-select").value); await Promise.all([loadLayouts(), loadServices()]); });
  $("service-date").addEventListener("change", loadServices); $("service-select").addEventListener("change", () => loadService(Number($("service-select").value)));
  $("new-service-btn").addEventListener("click", () => openServiceDialog().catch(showError));
  $("party-form").addEventListener("submit", event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); saveParty().catch(showError); });
  $("seat-form").addEventListener("submit", event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); confirmSeat().catch(showError); });
  $("service-form").addEventListener("submit", event => { if (event.submitter?.value === "cancel") return; event.preventDefault(); createService().catch(showError); });
  document.querySelectorAll("[data-zoom]").forEach(button => button.addEventListener("click", () => { state.zoom = Math.min(1.4, Math.max(.55, state.zoom + Number(button.dataset.zoom))); renderFloor(); }));
  $("new-layout-btn").addEventListener("click", newLayout); $("add-table-btn").addEventListener("click", addEditorTable); $("add-text-block-btn").addEventListener("click", addTextBlock); $("save-layout-btn").addEventListener("click", () => saveLayout().catch(showError)); $("publish-layout-btn").addEventListener("click", () => publishLayout().catch(showError));
  $("duplicate-table-btn").addEventListener("click", duplicateSelectedTable);
  ["table-number", "table-label"].forEach(id => $(id).addEventListener("input", () => updateSelectedTable(false))); ["table-shape", "table-capacity"].forEach(id => $(id).addEventListener("change", () => updateSelectedTable(true)));
  ["area-name", "area-width", "area-height"].forEach(id => $(id).addEventListener("input", () => updateArea(false))); $("area-shape").addEventListener("change", () => updateArea(true)); $("fixture-text").addEventListener("input", () => updateTextBlock(false));
  $("save-rotation-btn").addEventListener("click", () => saveRotation().catch(showError)); $("close-service-btn").addEventListener("click", () => closeService().catch(showError));
  window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || state.currentView !== "layouts" || state.editorLayout?.status !== "DRAFT") return;
    if (event.target.closest?.("input,select,textarea,[contenteditable='true']")) return;
    if (event.key.toLowerCase() === "c" && state.editorSelected !== null) { event.preventDefault(); copySelectedTable(); }
    if (event.key.toLowerCase() === "v") { event.preventDefault(); pasteCopiedTable(); }
  });
  window.addEventListener("beforeunload", () => state.socket?.close());
  setInterval(() => { if (state.currentView === "floor" && state.snapshot) { renderMetrics(); renderFloor(); renderDetail(); } }, 60000);
  setInterval(() => { if (state.service && document.visibilityState === "visible") refreshService().catch(() => setSync("Offline", "error")); }, 15000);
  initialize().catch(showError);
})();
