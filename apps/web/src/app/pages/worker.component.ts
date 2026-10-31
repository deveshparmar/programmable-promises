import { Component, NgZone, OnDestroy, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { ApiService } from "../api.service";
import { apiUrl } from "../api-url";
import { ToastService } from "../toast.service";
import { money, pillClass, statusLabel, type PromiseView, type Verification } from "../models";

const LIVE_POLL_MS = 2000;
const POST_SUBMIT_STATUSES = new Set(["VERIFYING", "SUBMITTED", "APPROVED", "PAYING", "CAPTURED"]);

@Component({
  selector: "app-worker",
  template: `
    @if (!promise() && loaded()) {
      <p class="note">This worker link is invalid or expired.</p>
    }
    @if (promise(); as current) {
      <section class="stack">
        <div class="row" style="justify-content: space-between;">
          <h1>{{ current.title }}</h1>
          <span [class]="pillClass(current.status)">{{ statusLabel(current.status) }}</span>
        </div>
        <p class="lede">{{ money(current.amount_minor) }} is held until this photo passes. {{ current.description }}</p>
        @if (liveHint()) {
          <p class="note">{{ liveHint() }}</p>
        }
        <div class="card stack">
          <h2>Show this code in the photo</h2>
          @if (code()) { <div class="code">{{ code() }}</div> }
          <p class="muted">Write it on paper, in the same photo as the work. A stock image will not pass.</p>
          <button class="secondary" type="button" (click)="issue()" [disabled]="busy()">Get a new code</button>
          <label>Photo, jpg or png
            <input type="file" accept="image/jpeg,image/png" (change)="choose($event)" />
          </label>
          <button class="primary" type="button" (click)="send()" [disabled]="busy() || !file">
            {{ busy() ? "Checking photo…" : "Submit photo" }}
          </button>
          @if (busy()) {
            <div class="progress-inline" aria-hidden="true"><div></div></div>
            <p class="muted">This page updates automatically — no refresh needed.</p>
          }
          @if (feedback()) { <p class="note">{{ feedback() }}</p> }
        </div>
        @for (verification of verifications(); track verification.id) {
          <article class="card stack">
            <strong>{{ verification.verdict }}</strong>
            <p>{{ verification.worker_feedback }}</p>
            @for (item of verification.items; track item.checklist_item_id) {
              <div class="evidence">
                <strong>{{ item.passed ? "Passed" : "Not shown" }}:</strong> {{ item.text }}
                <div class="muted">{{ item.evidence }}</div>
              </div>
            }
          </article>
        }
      </section>
    }
  `,
})
export class WorkerComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  readonly promise = signal<PromiseView | null>(null);
  readonly verifications = signal<Verification[]>([]);
  readonly code = signal("");
  readonly feedback = signal("");
  readonly liveHint = signal("");
  readonly busy = signal(false);
  readonly loaded = signal(false);
  file: File | null = null;
  readonly money = money;
  readonly statusLabel = statusLabel;
  readonly pillClass = pillClass;
  private id = "";
  private token = "";
  private eventSource?: EventSource;
  private pollTimer?: ReturnType<typeof setInterval>;
  private awaitingResult = false;
  private lastNotifiedStatus = "";

  constructor() {
    this.id = this.route.snapshot.paramMap.get("id") ?? "";
    this.token = this.route.snapshot.paramMap.get("token") ?? "";
    this.refresh();
    this.connectLiveUpdates();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
    this.stopPolling();
  }

  issue(): void {
    this.api.challenge(this.id, this.token).subscribe({
      next: (result) => {
        this.code.set(result.challenge_code);
        this.toast.info("New challenge code issued. Include it in your photo.");
      },
    });
  }

  choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.file = input.files?.[0] ?? null;
  }

  send(): void {
    if (!this.file) return;
    this.busy.set(true);
    this.awaitingResult = true;
    this.lastNotifiedStatus = "";
    this.liveHint.set("Uploading photo…");
    this.startPolling();
    this.api.submit(this.id, this.token, this.file).subscribe({
      next: (result) => {
        this.feedback.set(result.workerFeedback);
        this.file = null;
        if (result.status === "VERIFYING" && result.verdict === "pending") {
          this.liveHint.set("AI is checking your photo…");
          this.toast.info("Photo received. Verification is running.");
          return;
        }
        this.applySubmitResult(result.status, result.verdict);
      },
      error: () => {
        this.awaitingResult = false;
        this.finishBusy();
      },
    });
  }

  private connectLiveUpdates(): void {
    const url = apiUrl(`/api/promises/${this.id}/events?token=${encodeURIComponent(this.token)}`);
    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (event) => {
      this.zone.run(() => {
        this.onLiveMessage(event.data);
      });
    };
    this.eventSource.onerror = () => {
      this.zone.run(() => {
        if (this.awaitingResult) this.startPolling();
      });
    };
  }

  private onLiveMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as { status?: string; detail?: string };
      if (payload.status) this.refresh(payload.status);
    } catch {
      this.refresh();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.zone.run(() => this.refresh());
    }, LIVE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private refresh(statusHint?: string): void {
    this.api.get(this.id, this.token).subscribe({
      next: (promise) => {
        const prev = this.promise()?.status;
        this.promise.set(promise);
        this.loaded.set(true);
        this.updateLiveHint(promise.status);
        if (this.awaitingResult) {
          this.handleProgress(promise.status);
        } else if (statusHint && statusHint !== prev) {
          this.handleProgress(statusHint);
        }
      },
      error: () => this.loaded.set(true),
    });
    this.api.verifications(this.id, this.token).subscribe({
      next: (result) => this.verifications.set(result.verifications),
    });
  }

  private updateLiveHint(status: string): void {
    if (!this.awaitingResult && !POST_SUBMIT_STATUSES.has(status)) {
      this.liveHint.set("");
      return;
    }
    if (status === "VERIFYING" || status === "SUBMITTED") {
      this.liveHint.set("AI is checking your photo…");
      return;
    }
    if (status === "APPROVED" || status === "PAYING") {
      this.liveHint.set("Photo passed. Capturing payment…");
      return;
    }
    if (status === "CAPTURED") {
      this.liveHint.set("Paying you via PayPal…");
      return;
    }
    if (status === "PAID") {
      this.liveHint.set("Payment complete.");
    }
  }

  private handleProgress(status: string, verdict?: string): void {
    this.updateLiveHint(status);
    if (["VERIFYING", "SUBMITTED"].includes(status)) return;

    if (verdict === "pass" || verdict === "fail") {
      this.completeFlow(status, verdict);
      return;
    }

    if (["APPROVED", "PAYING", "CAPTURED"].includes(status)) {
      this.busy.set(false);
      return;
    }

    if (["PAID", "REJECTED_RETRY", "NEEDS_REVIEW", "FUNDED", "PAYMENT_FAILED"].includes(status)) {
      this.completeFlow(status);
    }
  }

  private applySubmitResult(status: string, verdict?: string): void {
    this.handleProgress(status, verdict);
  }

  private completeFlow(status: string, verdict?: string): void {
    if (this.lastNotifiedStatus === status && !verdict) return;
    this.lastNotifiedStatus = status;
    this.awaitingResult = false;
    this.stopPolling();
    this.finishBusy();
    this.notifyVerdict(status, verdict);
  }

  private finishBusy(): void {
    this.busy.set(false);
    if (!this.awaitingResult) this.liveHint.set("");
  }

  private notifyVerdict(status: string, verdict?: string): void {
    if (status === "PAID" || verdict === "pass") {
      this.toast.success("Photo passed. Payment is complete or on the way.");
      return;
    }
    if (verdict === "fail" || status === "REJECTED_RETRY") {
      this.toast.error("Photo did not pass. Read the feedback and try again with a new code.");
      return;
    }
    if (status === "NEEDS_REVIEW") {
      this.toast.info("The payer will review this photo manually.");
    }
  }
}
