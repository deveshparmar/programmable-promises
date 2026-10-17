import { Component, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { ApiService } from "../api.service";
import { money, pillClass, statusLabel, type PromiseView, type Verification } from "../models";

@Component({
  selector: "app-worker",
  template: `
    @if (promise(); as current) {
      <section class="stack">
        <div class="row" style="justify-content: space-between;">
          <h1>{{ current.title }}</h1>
          <span [class]="pillClass(current.status)">{{ statusLabel(current.status) }}</span>
        </div>
        <p class="lede">{{ money(current.amount_minor) }} is held until this photo passes. {{ current.description }}</p>
        <div class="card stack">
          <h2>Show this code in the photo</h2>
          @if (code()) { <div class="code">{{ code() }}</div> }
          <p class="muted">Write it on paper, in the same photo as the work. A stock image will not pass.</p>
          <button class="secondary" type="button" (click)="issue()" [disabled]="busy()">Get a new code</button>
          <label>Photo, jpg or png
            <input type="file" accept="image/jpeg,image/png" (change)="choose($event)" />
          </label>
          <button class="primary" type="button" (click)="send()" [disabled]="busy() || !file">
            {{ busy() ? "Checking…" : "Submit photo" }}
          </button>
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
        @if (error()) { <p class="error">{{ error() }}</p> }
      </section>
    }
  `,
})
export class WorkerComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  readonly promise = signal<PromiseView | null>(null);
  readonly verifications = signal<Verification[]>([]);
  readonly code = signal("");
  readonly feedback = signal("");
  readonly error = signal("");
  readonly busy = signal(false);
  file: File | null = null;
  readonly money = money;
  readonly statusLabel = statusLabel;
  readonly pillClass = pillClass;
  private id = "";
  private token = "";

  constructor() {
    this.id = this.route.snapshot.paramMap.get("id") ?? "";
    this.token = this.route.snapshot.paramMap.get("token") ?? "";
    this.reload();
  }

  issue(): void {
    this.error.set("");
    this.api.challenge(this.id, this.token).subscribe({
      next: (result) => this.code.set(result.challenge_code),
      error: (error: Error) => this.error.set(error.message),
    });
  }

  choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.file = input.files?.[0] ?? null;
  }

  send(): void {
    if (!this.file) return;
    this.busy.set(true);
    this.error.set("");
    this.api.submit(this.id, this.token, this.file).subscribe({
      next: (result) => {
        this.feedback.set(result.workerFeedback);
        this.busy.set(false);
        this.file = null;
        this.reload();
      },
      error: (error: Error) => {
        this.error.set(error.message);
        this.busy.set(false);
      },
    });
  }

  private reload(): void {
    this.api.get(this.id, this.token).subscribe({
      next: (promise) => this.promise.set(promise),
      error: (error: Error) => this.error.set(error.message),
    });
    this.api.verifications(this.id, this.token).subscribe({
      next: (result) => this.verifications.set(result.verifications),
    });
  }
}
