import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class VoiceService {
  private synth?: SpeechSynthesis;
  private lastSpoken = '';
  private lastSpokenTime = 0;
  enabled = true;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
    }
  }

  speak(text: string, force = false) {
    if (!this.enabled || !this.synth) return;
    const now = Date.now();
    // Prevent repeating identical instructions within 15 seconds unless forced
    if (!force && text === this.lastSpoken && now - this.lastSpokenTime < 15000) {
      return;
    }

    this.synth.cancel(); // Cancel ongoing utterance to give priority to latest instruction
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.lang = 'en-US';

    this.lastSpoken = text;
    this.lastSpokenTime = now;
    this.synth.speak(utterance);
  }

  stop() {
    if (this.synth) {
      this.synth.cancel();
    }
  }
}
