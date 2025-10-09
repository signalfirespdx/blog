window.addEventListener('load', onLoad);

// Minimal emoji index (extend as you like)
const EMOJI_INDEX = [
  { e: '📍', name: 'pin' },
  { e: '✅', name: 'check' },
  { e: '❌', name: 'x cross' },
  { e: '⚠️', name: 'warning caution' },
  { e: '🚧', name: 'construction work' },
  { e: '🏠', name: 'house home' },
  { e: '🏢', name: 'office building' },
  { e: '🌳', name: 'tree park' },
  { e: '🚲', name: 'bike bicycle' },
  { e: '🚗', name: 'car' },
  { e: '🚑', name: 'ambulance medical' },
  { e: '🚌', name: 'bus transit' },
  { e: '🚇', name: 'subway train' },
  { e: '🛠️', name: 'tools repair' },
  { e: '🧰', name: 'toolbox kit' },
  { e: '🧱', name: 'brick wall' },
  { e: '💧', name: 'water leak' },
  { e: '🔥', name: 'fire hot' },
  { e: '❄️', name: 'snow ice' },
  { e: '🅿️', name: 'parking' },
  { e: '🧹', name: 'cleanup' },
  { e: '♿', name: 'accessible accessibility' },
  { e: '🎉', name: 'party event' },
  { e: '📷', name: 'camera photo' },
];

function onLoad() {
  const map = L.map('map', { zoomControl: true });
  map.setView([45.515, -122.679], 12); // Portland

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
  }).addTo(map);

  if (L.Control.Fullscreen) {
    map.addControl(new L.Control.Fullscreen());
  }

  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  const drawControl = new L.Control.Draw({
    position: 'topleft',
    draw: {
      marker: true,
      polyline: true,
      polygon: { allowIntersection: false, showArea: true },
      rectangle: true,
      circle: false,
      circlemarker: false,
    },
    edit: {
      featureGroup: drawnItems,
      edit: true,
      remove: true,
    },
  });
  map.addControl(drawControl);

  // ---------------------- Records storage ----------------------
  const STORAGE_NS = 'lf.records.v1';
  const recordIndexKey = `${STORAGE_NS}:index`; // stores array of recordIds
  const recordKey = id => `${STORAGE_NS}:rec:${id}`;

  // in-memory maps
  const idToLayer = new Map(); // recordId -> Leaflet layer
  const layerToId = new WeakMap(); // layer -> recordId

  // user can set defaults for next record
  let defaultProps = {}; // you can fill via mini UI

  // ------------- Helpers: IDs, (de)serialization, properties -------------
  function newId() {
    return crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensureRecordId(layer) {
    let id = layerToId.get(layer);
    if (id) return id;

    // try reading from existing GeoJSON feature if present
    const feature = layer.feature;
    if (feature && feature.properties && feature.properties.recordId) {
      id = feature.properties.recordId;
    } else {
      id = newId();
    }

    layerToId.set(layer, id);
    idToLayer.set(id, layer);
    setLayerProp(layer, 'recordId', id, true);
    return id;
  }

  function getIndex() {
    try {
      const raw = localStorage.getItem(recordIndexKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function setIndex(ids) {
    localStorage.setItem(recordIndexKey, JSON.stringify(ids));
  }

  function upsertIndex(id) {
    const idx = getIndex();
    if (!idx.includes(id)) {
      idx.push(id);
      setIndex(idx);
    }
  }

  function removeFromIndex(id) {
    const idx = getIndex().filter(x => x !== id);
    setIndex(idx);
  }

  function layerToFeature(layer) {
    // Use Leaflet's built-in conversion
    const gj = layer.toGeoJSON();
    // Ensure properties exist and include recordId + our custom props
    gj.properties = { ...(gj.properties || {}) };
    const id = ensureRecordId(layer);
    gj.properties.recordId = id;
    // carry any existing props stored on layer
    const curr = getLayerProps(layer);
    Object.assign(gj.properties, curr);
    return gj;
  }

  function featureToLayer(feature) {
    const lyr = L.geoJSON(feature, {
      pointToLayer: (_feat, latlng) => {
        let marker = L.marker(latlng);
        return marker;
      },
    });
    let resolved = lyr;
    if (lyr.getLayers) {
      const children = lyr.getLayers();
      if (children.length === 1) resolved = children[0];
    }
    const id = feature.properties?.recordId || newId();
    layerToId.set(resolved, id);
    idToLayer.set(id, resolved);
    setLayerProps(resolved, feature.properties || {});
    return resolved;
  }

  // attach a single property on layer.feature.properties
  function setLayerProp(layer, key, value, createFeature = false) {
    if (!layer.feature) {
      if (!createFeature) return;
      layer.feature = { type: 'Feature', properties: {}, geometry: null };
    }
    layer.feature.properties ??= {};
    layer.feature.properties[key] = value;
  }

  // replace properties with a bag (without nuking recordId)
  function setLayerProps(layer, props = {}) {
    const id = ensureRecordId(layer);
    layer.feature ??= { type: 'Feature', properties: {}, geometry: null };
    layer.feature.properties = { ...props, recordId: id };
  }

  function getLayerProps(layer) {
    return layer.feature && layer.feature.properties ? { ...layer.feature.properties } : {};
  }

  // ---------------------- Save / Load / Delete a single record ----------------------
  function saveLayerRecord(layer, mutate = {}) {
    const id = ensureRecordId(layer);

    // merge props first
    if (Object.keys(mutate).length) {
      const merged = { ...getLayerProps(layer), ...mutate };
      setLayerProps(layer, merged);
    }

    // ensure we have the current popup HTML
    const popupHTML = uiPopup(layer);
    setLayerProp(layer, 'popupHTML', popupHTML, true);

    const feature = layerToFeature(layer); // now includes popupHTML in properties
    const now = new Date().toISOString();

    const existingRaw = localStorage.getItem(recordKey(id));
    let rec;
    if (existingRaw) {
      rec = JSON.parse(existingRaw);
      rec.feature = feature;
      rec.updatedAt = now;
    } else {
      rec = { id, feature, createdAt: now, updatedAt: now };
    }

    localStorage.setItem(recordKey(id), JSON.stringify(rec));
    upsertIndex(id);

    // apply icon + popup now that properties are final
    applyPresentation(layer);

    renderRecordsList();
    return rec;
  }

  function applyPresentation(layer) {
    // 1) Emoji icon for markers (or default pin)
    if (layer.getLatLng && layer.setIcon) {
      const p = getLayerProps(layer);
      if (p.emoji) {
        layer.setIcon(
          L.divIcon({
            className: 'emoji-marker',
            html: `<div class="emoji-glyph">${escapeHtml(p.emoji)}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
        );
      } else {
        layer.setIcon(new L.Icon.Default());
      }
    }

    // 2) Popup: use saved HTML if present, else regenerate
    const props = getLayerProps(layer);
    const html = props.popupHTML || uiPopup(layer);
    layer.bindPopup(html);
  }

  function deleteLayerRecordById(id) {
    localStorage.removeItem(recordKey(id));
    removeFromIndex(id);
    const layer = idToLayer.get(id);
    if (layer) {
      drawnItems.removeLayer(layer);
      idToLayer.delete(id);
    }
    renderRecordsList();
  }

  function loadAllRecords() {
    const ids = getIndex();
    ids.forEach(id => {
      try {
        const raw = localStorage.getItem(recordKey(id));
        if (!raw) return;
        const rec = JSON.parse(raw);
        const layer = featureToLayer(rec.feature);
        drawnItems.addLayer(layer);

        // Re-apply emoji + saved popup content (or regenerate)
        applyPresentation(layer);
      } catch (e) {
        console.warn('Bad record', id, e);
      }
    });
  }

  // ---------------------- Draw/edit/delete hooks ----------------------
  map.on(L.Draw.Event.CREATED, e => {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    setLayerProps(layer, { ...defaultProps, name: defaultProps.name || '' });

    // persist so it has an id + initial popupHTML
    saveLayerRecord(layer);

    // open editor (you already pass { map })
    showMetadataPopup(layer, { title: 'Describe this item', focus: 'desc', map });
  });

  // right-click quick marker (keep your dragend save)
  map.on('contextmenu', e => {
    const marker = L.marker(e.latlng, { draggable: true });
    marker.addTo(drawnItems);
    ensureRecordId(marker);
    saveLayerRecord(marker);
    marker.addEventListener('dragend', () => saveLayerRecord(marker));

    showMetadataPopup(marker, { title: 'Describe this point', focus: 'desc', map });
  });

  map.on(L.Draw.Event.EDITED, e => {
    e.layers.eachLayer(layer => {
      // keep same id; just update geometry & updatedAt
      saveLayerRecord(layer);
    });
  });

  map.on(L.Draw.Event.DELETED, e => {
    e.layers.eachLayer(layer => {
      const id = ensureRecordId(layer);
      deleteLayerRecordById(id);
    });
  });

  // ---------------------- Simple “My location” control ----------------------
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const btn = L.DomUtil.create('button', 'lf-locate-btn');
      btn.type = 'button';
      btn.title = 'Drop a point at your current location';
      btn.textContent = '📍 My location';
      Object.assign(btn.style, {
        background: '#fff',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(0,0,0,0.2)',
        cursor: 'pointer',
      });

      L.DomEvent.on(btn, 'click', ev => {
        L.DomEvent.stopPropagation(ev);
        L.DomEvent.preventDefault(ev);

        if (!navigator.geolocation) {
          alert('Geolocation not supported by this browser.');
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Locating…';

        navigator.geolocation.getCurrentPosition(
          pos => {
            const { latitude, longitude } = pos.coords;
            const ll = L.latLng(latitude, longitude);

            const you = L.marker(ll, { draggable: true });
            drawnItems.addLayer(you);
            setLayerProps(you, { name: 'My location' });
            saveLayerRecord(you);
            you.bindPopup(uiPopup(you)).openPopup();

            map.setView(ll, Math.max(map.getZoom(), 14));
            btn.disabled = false;
            btn.textContent = '📍 My location';
          },
          err => {
            alert('Unable to get location: ' + err.message);
            btn.disabled = false;
            btn.textContent = '📍 My location';
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      });

      return btn;
    },
  });
  map.addControl(new LocateControl());

  const listEl = document.getElementById('records-list');
  const addPropsBtn = document.getElementById('add-props');

  if (addPropsBtn) {
    addPropsBtn.addEventListener('click', () => {
      const name = prompt('Default name for next drawing? (optional)', defaultProps.name || '');
      if (name !== null) defaultProps.name = name.trim();
      const tag = prompt('Default tag for next drawing? (optional)', defaultProps.tag || '');
      if (tag !== null) defaultProps.tag = tag.trim();
    });
  }

  function recordTitle(rec) {
    const p = rec.feature?.properties || {};
    return p.name?.trim() || p.tag?.trim() || rec.id.slice(0, 8);
  }

  function uiRow(rec) {
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr auto';
    row.style.gap = '6px';
    row.style.alignItems = 'center';
    row.style.border = '1px solid rgba(0,0,0,.08)';
    row.style.borderRadius = '8px';
    row.style.padding = '6px';

    const left = document.createElement('div');
    left.innerHTML = `<div style="font-weight:600; line-height:1.2">${escapeHtml(
      recordTitle(rec)
    )}</div>
    <div style="font-size:12px; color:#666">${rec.id.slice(0, 8)} · ${new Date(
      rec.updatedAt
    ).toLocaleString()}</div>`;
    row.appendChild(left);

    const btns = document.createElement('div');
    btns.style.display = 'flex';
    btns.style.gap = '6px';

    const zoom = document.createElement('button');
    zoom.textContent = 'Zoom';
    zoom.title = 'Zoom to shape';
    zoom.onclick = () => {
      const layer = idToLayer.get(rec.id);
      if (!layer) return;
      if (layer.getBounds) {
        map.fitBounds(layer.getBounds().pad(0.2));
      } else if (layer.getLatLng) {
        map.setView(layer.getLatLng(), Math.max(map.getZoom(), 16));
      }
    };

    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.title = 'Set a display name';
    rename.onclick = () => {
      const layer = idToLayer.get(rec.id);
      if (!layer) return;
      const curr = getLayerProps(layer);
      const name = prompt('Record name:', curr.name || '');
      if (name === null) return;
      saveLayerRecord(layer, { name: name.trim() });
    };

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.title = 'Delete this record';
    del.onclick = () => {
      if (!confirm('Delete this record? This cannot be undone.')) return;
      deleteLayerRecordById(rec.id);
    };

    btns.appendChild(zoom);
    btns.appendChild(rename);
    btns.appendChild(del);
    row.appendChild(btns);

    return row;
  }

  function showMetadataPopup(layer, { title = 'Add details', focus = 'desc', map } = {}) {
    const p = getLayerProps(layer);
    // const container = L.DomUtil.create('div');
    const container = document.createElement('div');

    container.innerHTML = `
    <div style="min-width:260px">
      <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(title)}</div>

      <label style="display:grid; gap:4px; margin-bottom:6px;">
        <span style="font-size:12px; color:#555;">Emoji (optional)</span>
        <div style="display:flex; gap:6px;">
          <input id="lf-emoji" type="text" value="${escapeHtml(p.emoji || '')}"
                 style="flex:1; padding:6px 8px; border:1px solid #ddd; border-radius:6px;"
                 placeholder="e.g., 🅿️ or 🌳" maxlength="3"/>
          <button id="lf-emoji-open" type="button"
                  style="padding:6px 10px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer;">
            Pick
          </button>
        </div>
      </label>

      <div id="lf-emoji-picker" style="display:none; border:1px solid #eee; border-radius:8px; padding:8px; margin:-2px 0 6px 0; background:#fafafa;"></div>

      <label style="display:grid; gap:4px; margin-bottom:6px;">
        <span style="font-size:12px; color:#555;">Name</span>
        <input id="lf-name" type="text" value="${escapeHtml(p.name || '')}"
               style="padding:6px 8px; border:1px solid #ddd; border-radius:6px;"/>
      </label>

      <label style="display:grid; gap:4px; margin-bottom:8px;">
        <span style="font-size:12px; color:#555;">Description</span>
        <textarea id="lf-desc" rows="3"
                  style="padding:6px 8px; border:1px solid #ddd; border-radius:6px;">${escapeHtml(
                    p.description || ''
                  )}</textarea>
      </label>

      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="lf-cancel" type="button"
                style="padding:6px 10px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer;">Cancel</button>
        <button id="lf-save" type="button"
                style="padding:6px 10px; border-radius:6px; border:1px solid #0a7; background:#0a7; color:#fff; cursor:pointer;">Save</button>
      </div>
    </div>
  `;

    // Prevent map interactions
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    // Bind and open at an anchor (rect/polyline needs a point)
    layer.bindPopup(container);
    const anchor = getLayerAnchor(layer, map);
    setTimeout(() => layer.openPopup(anchor), 0);

    // Elements
    const emojiEl = container.querySelector('#lf-emoji');
    const nameEl = container.querySelector('#lf-name');
    const descEl = container.querySelector('#lf-desc');
    const saveBtn = container.querySelector('#lf-save');
    const cancelBtn = container.querySelector('#lf-cancel');
    const pickerHost = container.querySelector('#lf-emoji-picker');
    const pickerToggle = container.querySelector('#lf-emoji-open');

    // Searchable picker
    const picker = createEmojiPicker(chosenEmoji => {
      emojiEl.value = chosenEmoji;
      pickerHost.style.display = 'none';
    });
    pickerHost.appendChild(picker);

    pickerToggle.addEventListener('click', () => {
      pickerHost.style.display = pickerHost.style.display === 'none' ? 'block' : 'none';
    });

    setTimeout(() => (focus === 'name' ? nameEl : descEl).focus(), 0);

    function setEmojiIconOrDefault(layer, emoji) {
      // markers only
      if (!layer.setIcon || !layer.getLatLng) return;

      if (emoji) {
        layer.setIcon(
          L.divIcon({
            className: 'emoji-marker',
            html: `<div class="emoji-glyph">${escapeHtml(emoji)}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
        );
      } else {
        // revert to default leaflet pin
        layer.setIcon(new L.Icon.Default());
      }
    }

    function doSave() {
      const emoji = emojiEl.value.trim();
      const name = nameEl.value.trim();
      const description = descEl.value.trim();

      // Persist props; this also recomputes and saves popupHTML and reapplies presentation
      saveLayerRecord(layer, { emoji, name, description });

      layer.closePopup();
    }

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', () => layer.closePopup());

    // Keyboard: Enter saves (except Shift+Enter in textarea)
    nameEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSave();
      }
    });
    descEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSave();
      }
    });
  }

  function renderRecordsList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const ids = getIndex();
    // sort newest updated first
    const recs = ids
      .map(id => {
        const raw = localStorage.getItem(recordKey(id));
        return raw ? JSON.parse(raw) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    if (!recs.length) {
      const empty = document.createElement('div');
      empty.style.color = '#666';
      empty.style.fontSize = '13px';
      empty.textContent = 'No records yet — draw on the map to create one.';
      listEl.appendChild(empty);
      return;
    }
    recs.forEach(rec => listEl.appendChild(uiRow(rec)));
  }
  function escapeHtml(s = '') {
    return s.replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function getLayerAnchor(layer, map) {
    // Markers
    if (typeof layer.getLatLng === 'function') return layer.getLatLng();
    // Anything with bounds (Rectangle, Polygon, Polyline)
    if (typeof layer.getBounds === 'function') return layer.getBounds().getCenter();
    // Circles, etc.
    if (typeof layer.getCenter === 'function') return layer.getCenter();
    // Fallback
    return map.getCenter();
  }
  function createEmojiPicker(onPick) {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '6px';

    wrap.innerHTML = `
    <input id="lf-emoji-search" type="text" placeholder="Search emojis (e.g., parking, tree, fire)"
           style="padding:6px 8px; border:1px solid #ddd; border-radius:6px;" />
    <div id="lf-emoji-grid" style="display: flex; flex-wrap: wrap; gap:6px; max-height:140px; overflow:auto;"></div>
  `;

    const searchEl = wrap.querySelector('#lf-emoji-search');
    const gridEl = wrap.querySelector('#lf-emoji-grid');

    function render(q = '') {
      const term = q.trim().toLowerCase();
      const items = EMOJI_INDEX.filter(
        item => !term || item.name.includes(term) || item.e.includes(term)
      ).slice(0, 200);

      gridEl.innerHTML = '';
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = item.name;
        btn.style.cssText = `
        aspect-ratio: 1; border: none; background: none;
        padding:6px 0; cursor:pointer;
        font-size:20px; line-height:1.2; display:flex; align-items:center; justify-content:center;
      `;
        btn.textContent = item.e;
        btn.addEventListener('click', () => onPick(item.e));
        gridEl.appendChild(btn);
      }
    }

    render();
    searchEl.addEventListener('input', () => render(searchEl.value));

    return wrap;
  }

  function uiPopup(layer, prefix = '') {
    const p = getLayerProps(layer);
    const id = ensureRecordId(layer);
    const name = p.name || '';
    const lines = [];
    if (prefix) lines.push(`<div>${escapeHtml(prefix)}</div>`);
    lines.push(`<div><b>${escapeHtml(name)}</b></div>`);
    if (p.description) {
      lines.push(`<div style="margin-top:4px;">${escapeHtml(p.description)}</div>`);
    }
    lines.push(`<div style="font-size:12px;color:#666;margin-top:6px;">${id.slice(0, 8)}</div>`);
    return lines.join('');
  }

  loadAllRecords();
  renderRecordsList();
}
