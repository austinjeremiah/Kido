'use client';

import { useEffect } from 'react';

/**
 * Boots the site's runtime in the original page's order:
 *   jQuery -> Webflow runtime -> hls.js -> the custom Three.js module bundle
 *   -> the small inline setup script.
 *
 * The Three.js bundle (app.module.js) is an ES module that enhances the existing
 * DOM by querySelector (.webgl canvas, scene-* spacers, [data-insight] ...) and
 * loads its GLB models from /models and Draco decoders from gstatic. The inline
 * script sets --vh and removes the preloader.
 */
const CLASSIC = [
  '/vendor/jquery.min.js',
  '/vendor/webflow.js',
  '/vendor/hls.min.js',
];

let started = false;

function loadScript(src: string, type?: string) {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    if (type) el.type = type;
    el.async = false; // preserve order
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.body.appendChild(el);
  });
}

/**
 * Stops the landing's media calls from surfacing as runtime errors.
 *
 * The background loop and the narration clips were deliberately left sourceless
 * when the audio was removed, because the engine holds those elements by query
 * and calls play()/pause() on them — deleting them throws. But play() on an
 * element with no source returns a promise that rejects the moment pause()
 * follows it, which React surfaces as:
 *
 *   AbortError: The play() request was interrupted by a call to pause()
 *
 * The call is harmless and there is nothing to hear either way, so play() is
 * replaced on these elements with a resolved promise. Only elements we
 * silenced are touched; any other media on the page keeps its real play().
 */
function neutraliseMediaRejections() {
  /*
   * The silenced clips have no source at all, so play() rejects the moment
   * pause() follows it. They exist only because the engine holds them by query
   * and calls play() on them; a resolved stub keeps that call harmless.
   */
  document.querySelectorAll<HTMLAudioElement>('audio.audio-bg, audio.audio-chapter').forEach((el) => {
    el.muted = true;
    el.play = () => Promise.resolve();
  });

  /*
   * The decorative videos DO play, so their play() has to keep working. What
   * they must not do is reject loudly: navigating away unmounts them while the
   * promise is still pending, and the browser rejects with
   *
   *   AbortError: The play() request was interrupted because the media was
   *   removed from the document
   *
   * which React surfaces as an unhandled runtime error. Wrapping the original
   * keeps playback and swallows only that.
   */
  document.querySelectorAll<HTMLVideoElement>('video').forEach((el) => {
    const original = el.play.bind(el);
    el.play = () => original().catch(() => undefined);
  });
}

/**
 * Keeps "Enter Site" meaning the mark, not the whole screen.
 *
 * The engine binds its intro to a click anywhere on .preloader, so any stray
 * click on the background — or on the chain chips and the protocol mesh, which
 * are children of it — dropped the visitor straight into the site. There is no
 * hook to rebind, so the click is filtered on the way DOWN instead: a capture
 * listener on document always runs before a listener on .preloader itself, and
 * anything outside the entry mark is stopped there. Once the preloader has been
 * removed the contains() check is false and this is inert.
 */
function restrictEnterToTheMark() {
  document.addEventListener(
    'click',
    (event) => {
      const preloader = document.querySelector('.preloader');
      const target = event.target as Element | null;
      if (!preloader || !target || !preloader.contains(target)) return;
      if (target.closest('.preloader__content')) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    },
    true,
  );
}

/**
 * Brings the CTA in with the hero instead of ahead of it.
 *
 * The engine fades its hero items up from a fixed list — .hero__scroll,
 * .trg-sound, .insigh-pannel, .main-logo, .trg-note — and .cl-hero-cta is not
 * on it, so the button sat at full strength while everything around it moved.
 * The list lives inside the bundle and cannot be extended, so the reveal is
 * driven from the one signal the engine does give us: it removes .preloader
 * partway through the intro, just before the hero items stagger in. Matching
 * that beat puts the button inside the same movement.
 *
 * The timeout is the safety net. If the bundle never boots the preloader is
 * never removed, and without it the only way into the product would stay
 * invisible.
 */
function revealCtaWithTheHero() {
  const show = () => document.body.classList.add('cl-entered');
  const preloader = document.querySelector('.preloader');
  if (!preloader) {
    show();
    return;
  }

  const observer = new MutationObserver(() => {
    if (preloader.isConnected) return;
    observer.disconnect();
    window.clearTimeout(fallback);
    window.setTimeout(show, 260);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const fallback = window.setTimeout(() => {
    observer.disconnect();
    show();
  }, 15000);
}

export default function SiteScripts() {
  useEffect(() => {
    if (started) return;
    started = true;

    (async () => {
      // Before the engine boots, so its first play() call already sees the stub.
      neutraliseMediaRejections();
      restrictEnterToTheMark();
      revealCtaWithTheHero();
      for (const src of CLASSIC) await loadScript(src);
      // ES module: its relative imports/model URLs resolve from /assets & /models
      await loadScript('/assets/app.module.js', 'module');
      await loadScript('/vendor/inline.js');
    })().catch((e) => console.error('[kido] script boot failed', e));
  }, []);

  return null;
}
