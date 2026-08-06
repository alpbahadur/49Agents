(function () {
  'use strict';

  var ENDPOINT = '/api/telemetry/events';
  var BATCH_INTERVAL = 5000;
  var queue = [];
  var sessionId = generateId();
  var pageLoadTime = Date.now();
  var animationStartTime = pageLoadTime;
  var animationEndTime = null;
  var maxScrollDepth = 0;
  var sectionsSeen = {};
  var tutorialInteracted = false;
  var ctaClicked = false;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function generateId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getUTM() {
    var params = new URLSearchParams(location.search);
    var utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
      var v = params.get(k);
      if (v) utm[k] = v;
    });
    return Object.keys(utm).length ? utm : null;
  }

  function getReferrer() {
    if (!document.referrer) return null;
    try {
      var ref = new URL(document.referrer);
      if (ref.hostname === location.hostname) return null;
      return ref.hostname + ref.pathname;
    } catch (e) {
      return null;
    }
  }

  function getDeviceInfo() {
    return {
      screen_width: screen.width,
      screen_height: screen.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      is_mobile: window.innerWidth < window.innerHeight,
      user_agent: navigator.userAgent
    };
  }

  function enqueue(event_type, data) {
    queue.push({
      event_type: event_type,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      page: location.pathname,
      data: data || {}
    });
  }

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0);
    var body = JSON.stringify({ events: batch });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    }
  }

  // ── 1. Page load event ─────────────────────────────────────────────────

  enqueue('page_view', {
    referrer: getReferrer(),
    utm: getUTM(),
    device: getDeviceInfo()
  });

  // ── 2. Scroll depth tracking ──────────────────────────────────────────

  var SECTIONS = [
    { id: 'show-animation', name: 'animation' },
    { id: 'show-mobile',    name: 'animation_mobile' },
    { id: 'section-pitch',  name: 'pitch' },
    { id: 'features',       name: 'features' },
    { id: 'section-tutorial', name: 'tutorial' },
    { id: 'section-setup',  name: 'setup' },
    { id: 'section-cta',    name: 'cta' }
  ];

  var sectionObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting && !sectionsSeen[entry.target.id]) {
        sectionsSeen[entry.target.id] = true;
        var name = '';
        for (var i = 0; i < SECTIONS.length; i++) {
          if (SECTIONS[i].id === entry.target.id) { name = SECTIONS[i].name; break; }
        }
        enqueue('section_viewed', {
          section: name,
          time_on_page_ms: Date.now() - pageLoadTime
        });
      }
    });
  }, { threshold: 0.2 });

  SECTIONS.forEach(function (s) {
    var el = document.getElementById(s.id);
    if (el) sectionObserver.observe(el);
  });

  // Track raw scroll depth percentage
  window.addEventListener('scroll', function () {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight > 0) {
      var pct = Math.round((scrollTop / docHeight) * 100);
      if (pct > maxScrollDepth) maxScrollDepth = pct;
    }
  }, { passive: true });

  // ── 3. Animation watch time ───────────────────────────────────────────

  // The animation section is the hero — track how long it's visible
  var animSection = document.getElementById('show-animation');
  if (animSection && animSection.style.display !== 'none') {
    var animObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting && animationEndTime === null) {
          // User scrolled past the animation for the first time
          animationEndTime = Date.now();
          enqueue('animation_watch_time', {
            duration_ms: animationEndTime - animationStartTime
          });
          animObserver.disconnect();
        }
      });
    }, { threshold: 0.1 });
    animObserver.observe(animSection);
  }

  // ── 4. Tutorial interaction ───────────────────────────────────────────

  // Detect clicks/focus on the tutorial iframe
  var tutorialWrap = document.querySelector('.tutorial-frame-wrap');
  if (tutorialWrap) {
    // When user clicks into the iframe area
    tutorialWrap.addEventListener('mousedown', function () {
      if (!tutorialInteracted) {
        tutorialInteracted = true;
        enqueue('tutorial_interaction', {
          time_on_page_ms: Date.now() - pageLoadTime
        });
      }
    });

    // Also detect via window blur (iframe steals focus)
    window.addEventListener('blur', function () {
      if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
        var iframe = document.activeElement;
        if (tutorialWrap.contains(iframe) && !tutorialInteracted) {
          tutorialInteracted = true;
          enqueue('tutorial_interaction', {
            time_on_page_ms: Date.now() - pageLoadTime
          });
        }
      }
    });
  }

  // ── 5. CTA click tracking ────────────────────────────────────────────

  var ctaButton = document.querySelector('.cta-button');
  if (ctaButton) {
    ctaButton.addEventListener('click', function () {
      if (!ctaClicked) {
        ctaClicked = true;
        enqueue('cta_click', {
          target: ctaButton.getAttribute('href'),
          time_on_page_ms: Date.now() - pageLoadTime
        });
        // Flush immediately since they're navigating away
        flush();
      }
    });
  }

  // Also track GitHub link clicks in setup steps
  document.querySelectorAll('.step-code').forEach(function (el) {
    el.addEventListener('click', function () {
      enqueue('setup_code_click', {
        code: el.textContent.trim(),
        time_on_page_ms: Date.now() - pageLoadTime
      });
    });
  });

  // ── 6. Time on page (sent on unload) ─────────────────────────────────

  function sendExitEvent() {
    enqueue('page_exit', {
      time_on_page_ms: Date.now() - pageLoadTime,
      max_scroll_depth_pct: maxScrollDepth,
      sections_seen: Object.keys(sectionsSeen),
      animation_watch_time_ms: animationEndTime ? animationEndTime - animationStartTime : Date.now() - animationStartTime,
      tutorial_interacted: tutorialInteracted,
      cta_clicked: ctaClicked
    });
    flush();
  }

  // Use both visibilitychange and beforeunload for best coverage
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendExitEvent();
  });
  window.addEventListener('beforeunload', sendExitEvent);

  // ── 7. Periodic flush ─────────────────────────────────────────────────

  setInterval(flush, BATCH_INTERVAL);

})();
