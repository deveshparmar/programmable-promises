import { Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService } from "../api.service";
import { money, type PromiseView, type Verification } from "../models";

@Component({
  selector: "app-review",
  imports: [RouterLink],
  template: `
    <section class="stack">
      <h1>Decisions waiting on you</h1>
      <p class="lede">Unsure photos, failed checks after three tries, and verifier errors land here. Approving pays. Denying releases the hold.</p>
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (!items().length) { <div class="card">Nothing is waiting.</div> }
      @for (item of items(); track item.promise.id) {
        <article class="card stack">
          <div class="row" style="justify-content: space-between;">
            <div>
              <strong>{{ item.promise.title }}</strong>
              <div class="muted">{{ money(item.promise.amount_minor) }} to {{ item.promise.worker_email }}</div>
            </div>
            <a [routerLink]="['/promises', item.promise.id]">Open</a>
          </div>
          @if (item.verification) {
            <p>{{ item.verification.worker_feedback }}</p>
            @for (line of item.verification.items; track line.checklist_item_id) {
              <div class="evidence"><strong>{{ line.passed ? "Passed" : "Not shown" }}:</strong> {{ line.text }} — {{ line.evidence }}</div>
            }
          }
          <div class="row">
            <button class="primary" type="button" (click)="decide(item.promise, 'approve')">Approve and pay</button>
            <button class="danger" type="button" (click)="decide(item.promise, 'deny')">Deny and release</button>
          </div>
        </article>
      }
    </section>
  `,
})
export class ReviewComponent {
  private readonly api = inject(ApiService);
  readonly items = signal<{ promise: PromiseView; verification?: Verification }[]>([]);
  readonly error = signal("");
  readonly money = money;

  constructor() {
    this.load();
  }

  decide(promise: PromiseView, decision: "approve" | "deny"): void {
    this.api.review(promise.id, {
      decision,
      amount_minor: promise.amount_minor,
      currency: promise.currency,
      worker_email: promise.worker_email,
      checklist_version: promise.checklist_version,
    }).subscribe({
      next: () => this.load(),
      error: (error: Error) => this.error.set(error.message),
    });
  }

  private load(): void {
    this.api.list().subscribe({
      next: (promises) => {
        const waiting = promises.filter((promise) => promise.status === "NEEDS_REVIEW");
        this.items.set(waiting.map((promise) => ({ promise })));
        for (const promise of waiting) {
          this.api.verifications(promise.id).subscribe((result) => {
            this.items.update((items) =>
              items.map((item) => item.promise.id === promise.id ? { ...item, verification: result.verifications[0] } : item),
            );
          });
        }
      },
      error: (error: Error) => this.error.set(error.message),
    });
  }
}
