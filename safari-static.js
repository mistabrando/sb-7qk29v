(function () {
  'use strict';

  var catalog = { live: [], vod: [], series: [], liveCategories: [], vodCategories: [], seriesCategories: [] };
  var state = {
    view: 'live',
    category: 'all',
    query: '',
    rows: [],
    current: null,
    favorites: loadFavorites(),
    renderToken: 0,
  };

  var els = {
    lockScreen: document.getElementById('lockScreen'),
    unlockForm: document.getElementById('unlockForm'),
    catalogPassword: document.getElementById('catalogPassword'),
    unlockError: document.getElementById('unlockError'),
    summary: document.getElementById('summary'),
    video: document.getElementById('video'),
    nowTitle: document.getElementById('nowTitle'),
    nowMeta: document.getElementById('nowMeta'),
    status: document.getElementById('status'),
    search: document.getElementById('search'),
    clearSearch: document.getElementById('clearSearch'),
    categories: document.getElementById('categories'),
    results: document.getElementById('results'),
    resultsTitle: document.getElementById('resultsTitle'),
    resultsCount: document.getElementById('resultsCount'),
    favoriteBtn: document.getElementById('favoriteBtn'),
    copyBtn: document.getElementById('copyBtn'),
    openBtn: document.getElementById('openBtn'),
    installHint: document.getElementById('installHint'),
  };

  var liveByCategory = {};
  var vodByCategory = {};
  var seriesByCategory = {};
  var searchTimer = null;
  var maxRenderedCards = 420;

  init();

  function init() {
    els.summary.textContent = 'Catalog locked.';
    bindEvents();
    renderAll();
  }

  function bindEvents() {
    els.unlockForm.addEventListener('submit', function (event) {
      event.preventDefault();
      unlockCatalog();
    });

    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        document.querySelectorAll('[data-view]').forEach(function (tab) {
          tab.classList.toggle('active', tab === button);
        });
        state.view = button.dataset.view;
        state.category = 'all';
        renderAll();
      });
    });

    els.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.query = normalize(els.search.value);
        renderResults();
      }, 90);
    });

    els.clearSearch.addEventListener('click', function () {
      els.search.value = '';
      state.query = '';
      renderResults();
    });

    els.favoriteBtn.addEventListener('click', function () {
      if (!state.current) return;
      var key = favoriteKey(state.current);
      if (state.favorites[key]) delete state.favorites[key];
      else state.favorites[key] = state.current;
      saveFavorites();
      updateFavoriteButton();
      if (state.view === 'favorites') renderAll();
    });

    els.copyBtn.addEventListener('click', function () {
      if (!state.current) return;
      navigator.clipboard.writeText(state.current.url).then(function () {
        setStatus('Copied stream URL.', 'good');
      });
    });

    els.video.addEventListener('loadedmetadata', function () {
      setStatus('Loaded metadata. Tap play if it does not start automatically.', 'good');
    });
    els.video.addEventListener('canplay', function () {
      setStatus('Ready to play in Safari.', 'good');
    });
    els.video.addEventListener('error', function () {
      var code = els.video.error ? els.video.error.code : 'unknown';
      if (state.current && isMixedStream(state.current.url)) {
        setStatus('Mobile Safari blocks this HTTP stream inside the HTTPS page. Tap Open Stream to play it directly.', 'bad');
        return;
      }
      setStatus('Playback error. Safari reported media error code ' + code + '.', 'bad');
    });

    els.installHint.addEventListener('click', function () {
      setStatus('GitHub Pages is HTTPS. HTTP streams may need Open Stream on iPhone Safari.', 'good');
    });
  }

  function unlockCatalog() {
    var password = els.catalogPassword.value;
    if (!password) return;
    var linkKey = readLinkKey();
    if (!linkKey) {
      els.unlockError.textContent = 'This private link is missing its unlock key.';
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      els.unlockError.textContent = 'Safari requires HTTPS or a local file for password unlock.';
      return;
    }
    els.unlockError.textContent = 'Unlocking...';
    loadEncryptedCatalog(password + '\n' + linkKey)
      .then(function (unlocked) {
        catalog = unlocked;
        liveByCategory = countByCategory(catalog.live);
        vodByCategory = countByCategory(catalog.vod);
        seriesByCategory = countByCategory(catalog.series);
        els.summary.textContent =
          formatNumber(catalog.live.length) +
          ' live streams loaded locally' +
          (catalog.vod.length ? ', ' + formatNumber(catalog.vod.length) + ' movies' : '') +
          (catalog.series.length ? ', ' + formatNumber(catalog.series.length) + ' series.' : '.');
        els.lockScreen.classList.add('hidden');
        els.catalogPassword.value = '';
        els.unlockError.textContent = '';
        renderAll();
      })
      .catch(function () {
        els.unlockError.textContent = 'Incorrect password, missing link key, or damaged catalog.';
      });
  }

  function readLinkKey() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return '';
    var params = new URLSearchParams(hash);
    return params.get('k') || hash;
  }

  function loadEncryptedCatalog(password) {
    if (window.ENCRYPTED_STREAM_CATALOG) {
      return decryptJson(window.ENCRYPTED_STREAM_CATALOG, password);
    }
    return fetch('encrypted-catalog.json', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Catalog not found');
        return response.json();
      })
      .then(function (payload) {
        return decryptJson(payload, password);
      });
  }

  function decryptJson(payload, password) {
    var salt = base64ToBytes(payload.salt);
    var iv = base64ToBytes(payload.iv);
    var data = base64ToBytes(payload.data);
    var encoder = new TextEncoder();
    return crypto.subtle
      .importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (keyMaterial) {
        return crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: salt,
            iterations: payload.iterations,
            hash: 'SHA-256',
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt'],
        );
      })
      .then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      })
      .then(function (buffer) {
        return JSON.parse(new TextDecoder().decode(buffer));
      });
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function renderAll() {
    renderCategories();
    renderResults();
  }

  function renderCategories() {
    var categories = activeCategories();
    var counts = state.view === 'vod' ? vodByCategory : state.view === 'series' ? seriesByCategory : liveByCategory;
    els.categories.innerHTML = '';

    var allButton = categoryButton({ id: 'all', name: 'All' }, activeItems().length);
    els.categories.appendChild(allButton);

    categories.forEach(function (category) {
      var count = counts[category.id] || 0;
      if (!count) return;
      els.categories.appendChild(categoryButton(category, count));
    });
  }

  function categoryButton(category, count) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'category' + (String(category.id) === String(state.category) ? ' active' : '');
    button.innerHTML = '<span>' + escapeHtml(category.name) + '</span><span>' + formatNumber(count) + '</span>';
    button.addEventListener('click', function () {
      state.category = category.id;
      renderCategories();
      renderResults();
    });
    return button;
  }

  function renderResults() {
    var token = ++state.renderToken;
    var rows = filteredItems();
    state.rows = rows;

    els.resultsTitle.textContent = titleForView();
    var renderRows = rows.slice(0, maxRenderedCards);
    els.resultsCount.textContent =
      formatNumber(rows.length) +
      (rows.length === 1 ? ' stream' : ' streams') +
      (rows.length > renderRows.length ? ' · showing ' + formatNumber(renderRows.length) : '');
    els.results.innerHTML = '';

    if (!rows.length) {
      els.results.innerHTML = '<p class="empty">No matches.</p>';
      return;
    }

    var firstBatch = renderRows.slice(0, 80);
    appendCards(firstBatch);

    var index = 80;
    function more() {
      if (token !== state.renderToken || index >= renderRows.length) return;
      appendCards(renderRows.slice(index, index + 80));
      index += 80;
      if (index < renderRows.length) requestAnimationFrame(more);
    }
    if (index < renderRows.length) requestAnimationFrame(more);
  }

  function appendCards(items) {
    var fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      fragment.appendChild(card(item));
    });
    els.results.appendChild(fragment);
  }

  function card(item) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    var icon = item.icon ? '<img class="thumb" loading="lazy" src="' + escapeHtml(item.icon) + '" alt="">' : thumbFallback(item);
    button.innerHTML =
      icon +
      '<span><span class="card-title">' +
      escapeHtml(item.name) +
      '</span><span class="card-meta">' +
      escapeHtml(metaForItem(item)) +
      '</span></span>';
    button.addEventListener('click', function () {
      if (item.type === 'series') {
        renderEpisodes(item);
        return;
      }
      play(item, true);
    });
    return button;
  }

  function metaForItem(item) {
    if (item.type === 'episode') {
      var label = 'S' + pad2(item.season) + ' E' + pad2(item.episode);
      var player = item.player === 'vlc' ? 'VLC' : 'Safari';
      return (item.duration ? label + ' · ' + item.duration : label) + ' · ' + player;
    }
    if (item.type === 'series') {
      var count = (item.episodes || []).length;
      return item.category + (count ? ' · ' + count + ' episodes indexed' : ' · episodes pending');
    }
    return item.category;
  }

  function renderEpisodes(series) {
    state.current = null;
    els.resultsTitle.textContent = series.name;
    els.resultsCount.textContent = formatNumber((series.episodes || []).length) + ' episodes';
    els.results.innerHTML = '';
    els.nowTitle.textContent = series.name;
    els.nowMeta.textContent = series.plot || series.category;
    els.openBtn.classList.add('disabled');
    els.copyBtn.disabled = true;
    els.favoriteBtn.disabled = true;
    if (!series.episodes || !series.episodes.length) {
      els.results.innerHTML = '<p class="empty">Episode details have not been indexed for this show yet.</p>';
      setStatus('This show is in the top-series index, but its episode list is not packed yet.', 'bad');
      return;
    }
    appendCards(series.episodes);
    setStatus('Choose an episode. Mobile Safari will open it in a new tab.', 'good');
  }

  function thumbFallback(item) {
    var initials = item.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part[0]; })
      .join('')
      .toUpperCase();
    return '<span class="thumb-fallback">' + escapeHtml(initials || 'TV') + '</span>';
  }

  function play(item, openExternal) {
    state.current = item;
    els.nowTitle.textContent = item.name;
    els.nowMeta.textContent = item.category;
    els.openBtn.href = item.player === 'vlc' ? vlcStreamUrl(item.url) : item.url;
    els.openBtn.textContent = item.player === 'vlc' ? 'Open in VLC' : 'Open in New Tab';
    els.openBtn.classList.remove('disabled');
    els.copyBtn.disabled = false;
    els.favoriteBtn.disabled = false;
    updateFavoriteButton();

    if (item.player === 'vlc') {
      els.video.removeAttribute('src');
      els.video.load();
      if (openExternal) {
        openVlcWindow(item.url);
      } else {
        setStatus('This episode needs VLC on iPhone. Tap Open in VLC.', 'bad');
      }
      return;
    }

    if (isMixedStream(item.url)) {
      els.video.removeAttribute('src');
      els.video.load();
      if (openExternal) {
        openStreamWindow(item.url);
      } else {
        setStatus('Mobile Safari blocks inline HTTP video here. Tap Open in New Tab to play the selected channel.', 'bad');
      }
      return;
    }

    els.video.src = item.url;
    els.video.load();
    setStatus('Loading direct HLS stream...', '');

    var promise = els.video.play();
    if (promise && promise.catch) {
      promise.catch(function () {
        setStatus('Safari may require a tap on the video play button.', '');
      });
    }
  }

  function isMixedStream(url) {
    return window.location.protocol === 'https:' && /^http:\/\//i.test(String(url || ''));
  }

  function openStreamWindow(url) {
    var popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (popup) {
      setStatus('Opening stream in a new Safari tab...', 'good');
    } else {
      setStatus('Safari blocked the new tab. Tap Open in New Tab.', 'bad');
    }
  }

  function vlcStreamUrl(url) {
    return 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
  }

  function openVlcWindow(url) {
    var popup = window.open(vlcStreamUrl(url), '_blank', 'noopener,noreferrer');
    if (popup) {
      setStatus('Opening episode in VLC...', 'good');
    } else {
      setStatus('Safari blocked VLC. Tap Open in VLC.', 'bad');
    }
  }

  function updateFavoriteButton() {
    if (!state.current) return;
    els.favoriteBtn.textContent = state.favorites[favoriteKey(state.current)] ? 'Unfavorite' : 'Favorite';
  }

  function filteredItems() {
    var items = activeItems();
    var query = state.query;
    var category = String(state.category);
    if (category !== 'all') {
      items = items.filter(function (item) {
        return String(item.categoryId) === category;
      });
    }
    if (query) {
      var parts = query.split(' ').filter(Boolean);
      items = items.filter(function (item) {
        return parts.every(function (part) {
          return item.search.indexOf(part) !== -1;
        });
      });
    }
    return items;
  }

  function activeItems() {
    if (state.view === 'favorites') return Object.keys(state.favorites).map(function (key) { return state.favorites[key]; });
    if (state.view === 'vod') return catalog.vod || [];
    if (state.view === 'series') return catalog.series || [];
    return catalog.live || [];
  }

  function activeCategories() {
    if (state.view === 'vod') return catalog.vodCategories || [];
    if (state.view === 'series') return catalog.seriesCategories || [];
    if (state.view === 'favorites') {
      var seen = {};
      return activeItems()
        .filter(function (item) {
          if (seen[item.categoryId]) return false;
          seen[item.categoryId] = true;
          return true;
        })
        .map(function (item) {
          return { id: item.categoryId, name: item.category };
        })
        .sort(function (a, b) {
          return a.name.localeCompare(b.name);
        });
    }
    return catalog.liveCategories || [];
  }

  function countByCategory(items) {
    return (items || []).reduce(function (counts, item) {
      counts[item.categoryId] = (counts[item.categoryId] || 0) + 1;
      return counts;
    }, {});
  }

  function titleForView() {
    if (state.view === 'favorites') return 'Favorites';
    if (state.view === 'vod') return 'VOD';
    if (state.view === 'series') return 'Series';
    return 'Live';
  }

  function setStatus(message, tone) {
    els.status.textContent = message;
    els.status.className = 'status' + (tone ? ' ' + tone : '');
  }

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function pad2(value) {
    return String(value || 0).padStart(2, '0');
  }

  function favoriteKey(item) {
    return item.type + ':' + item.id;
  }

  function loadFavorites() {
    try {
      return JSON.parse(localStorage.getItem('safariStreamFavorites') || '{}');
    } catch {
      return {};
    }
  }

  function saveFavorites() {
    localStorage.setItem('safariStreamFavorites', JSON.stringify(state.favorites));
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char];
    });
  }
})();
