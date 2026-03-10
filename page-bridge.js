(() => {
  const RESPONSE_EVENT = 'yt-transcript-overlay:player-response';
  const REQUEST_EVENT = 'yt-transcript-overlay:request-player-response';
  const NAV_EVENT = 'yt-transcript-overlay:navigation';

  function parseJsonAfterMarker(source, marker) {
    const start = source.indexOf(marker);
    if (start === -1) return null;

    let i = start + marker.length;
    while (i < source.length && source[i] !== '{') i += 1;
    if (i >= source.length) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    const begin = i;

    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const jsonText = source.slice(begin, i + 1);
          try {
            return JSON.parse(jsonText);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function findPlayerResponse() {
    const player = document.getElementById('movie_player');
    const playerApiResponse = player?.getPlayerResponse?.();
    const directCandidates = [
      playerApiResponse,
      window.ytInitialPlayerResponse,
      window.__INITIAL_PLAYER_RESPONSE__,
      window._yt_player_response,
      window.ytplayer?.config?.args?.player_response ? JSON.parse(window.ytplayer.config.args.player_response) : null
    ];

    for (const candidate of directCandidates) {
      if (candidate && typeof candidate === 'object') return candidate;
    }

    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text) continue;
      const parsed =
        parseJsonAfterMarker(text, 'var ytInitialPlayerResponse = ') ||
        parseJsonAfterMarker(text, 'window["ytInitialPlayerResponse"] = ') ||
        parseJsonAfterMarker(text, 'ytInitialPlayerResponse = ') ||
        parseJsonAfterMarker(text, 'var playerResponse = ');
      if (parsed) return parsed;
    }

    return null;
  }

  function dispatchPlayerResponse() {
    const detail = {
      url: location.href,
      playerResponse: findPlayerResponse()
    };
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
  }

  function dispatchNavigation() {
    window.dispatchEvent(
      new CustomEvent(NAV_EVENT, {
        detail: { url: location.href, ts: Date.now() }
      })
    );
  }

  window.addEventListener(REQUEST_EVENT, dispatchPlayerResponse);
  window.addEventListener('yt-navigate-finish', () => {
    dispatchNavigation();
    setTimeout(dispatchPlayerResponse, 200);
    setTimeout(dispatchPlayerResponse, 1000);
  });
  window.addEventListener('yt-page-data-updated', () => {
    dispatchNavigation();
    setTimeout(dispatchPlayerResponse, 200);
  });
  document.addEventListener('spfdone', () => {
    dispatchNavigation();
    setTimeout(dispatchPlayerResponse, 200);
  });

  dispatchNavigation();
  setTimeout(dispatchPlayerResponse, 300);
})();
