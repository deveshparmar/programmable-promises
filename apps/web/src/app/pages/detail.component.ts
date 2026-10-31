import { DatePipe } from "@angular/common";
import { Component, ElementRef, NgZone, OnDestroy, inject, signal, viewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import { ApiService } from "../api.service";
import { apiUrl } from "../api-url";
import { ToastService } from "../toast.service";
import { money, pillClass, statusLabel, type ChecklistItem, type PromiseView, type Verification } from "../models";

interface PayPalButtons {
  Buttons: (options: {
    createOrder: () => Promise<string>;
    onApprove: () => Promise<void>;
    onError: (error: unknown) => void;
  }) => { render: (element: HTMLElement) => Promise<void> };
}

declare global {
  interface Window { paypal?: PayPalButtons; }
}

@Component({
  selector: "app-detail",
  imports: [FormsModule, DatePipe],
  template: `
    @if (promise(); as current) {
      <section class="stack">
        <div class="row" style="justify-content: space-between;">
          <div>
            <h1>{{ current.title }}</h1>
            <p class="lede">{{ money(current.amount_minor) }} held for {{ current.worker_email }} until {{ current.deadline_at | date: 'medium' }}.</p>
          </div>
          <span [class]="pillClass(current.status)">{{ statusLabel(current.status) }}</span>
        </div>
        @if (current.status_detail) { <p class="note">{{ current.status_detail }}</p> }
        @if (workerUrl()) {
          <div class="card">
            <strong>Worker link, shown for this browser session</strong>
            <p><a [href]="workerUrl()">{{ workerUrl() }}</a></p>
          </div>
        }
        <div class="split">
          <div class="card stack">
            <h2>Checklist</h2>
            <p>{{ current.description }}</p>
            @if (editable()) {
              @if (!draft().length) {
                <p class="note">No checklist items yet. Add one, then confirm.</p>
              }
              @for (item of draft(); track $index) {
                <div class="check">
                  <input [(ngModel)]="item.text" [name]="'text' + $index" />
                  <input type="number" step="0.1" min="0.1" [(ngModel)]="item.weight" [name]="'weight' + $index" />
                  <label><input type="checkbox" [(ngModel)]="item.required" [name]="'req' + $index" /> Required</label>
                  <button class="text-button" type="button" (click)="remove($index)">Remove</button>
                </div>
              }
              <div class="row">
                <button class="secondary" type="button" (click)="add()">Add item</button>
                <button class="secondary" type="button" (click)="save(false)">Save draft</button>
                <button class="primary" type="button" (click)="save(true)">Confirm checklist</button>
              </div>
            } @else {
              @for (item of current.checklist; track item.id) {
                <div><strong>{{ item.required ? "Required" : "Optional" }}.</strong> {{ item.text }}</div>
              }
            }
          </div>
          <div class="card stack">
            <h2>Money</h2>
            @if (current.status === 'AWAITING_FUNDING') {
              <p>Confirming the checklist lets you authorize a hold. Capture happens only after a pass or your approval.</p>
              <div #paypal></div>
            }
            @if (current.status === 'PAYING' || current.status === 'PAYMENT_FAILED' || current.status === 'CAPTURED') {
              <button class="primary" type="button" (click)="retryPay()">Retry payment</button>
            }
            @if (canCancel()) {
              <button class="danger" type="button" (click)="cancel()">Cancel and release the hold</button>
            }
            @if (current.status === 'PAID') { <p>The worker has been paid.</p> }
          </div>
        </div>
        <div class="stack">
          @for (verification of verifications(); track verification.id) {
            <article class="card stack">
              <div class="row" style="justify-content: space-between;">
                <strong>{{ verification.verdict }}</strong>
                <span class="muted">{{ verification.model }}</span>
              </div>
              <p>{{ verification.worker_feedback }}</p>
              @for (item of verification.items; track item.checklist_item_id) {
                <div class="evidence">
                  <strong>{{ item.passed ? "Passed" : "Not shown" }}:</strong> {{ item.text }}
                  <div class="muted">{{ item.evidence }}</div>
                </div>
              }
            </article>
          }
        </div>
      </section>
    }
  `,
})
export class DetailComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly route = inject(ActivatedRoute);
  private readonly paypalHost = viewChild<ElementRef<HTMLElement>>("paypal");
  readonly promise = signal<PromiseView | null>(null);
  readonly verifications = signal<Verification[]>([]);
  readonly draft = signal<ChecklistItem[]>([]);
  readonly workerUrl = signal("");
  readonly money = money;
  readonly statusLabel = statusLabel;
  readonly pillClass = pillClass;
  private paypalReady = false;
  private source?: EventSource;

  constructor() {
    const id = this.route.snapshot.paramMap.get("id") ?? "";
    this.workerUrl.set(sessionStorage.getItem(`pp_worker_${id}`) ?? "");
    this.reload();
    const token = sessionStorage.getItem("pp_token");
    if (token) {
      this.source = new EventSource(apiUrl(`/api/promises/${id}/events?access_token=${encodeURIComponent(token)}`));
      this.source.onmessage = () => this.zone.run(() => this.reload());
    }
  }

  editable(): boolean {
    const status = this.promise()?.status;
    return status === "DRAFT" || status === "AWAITING_FUNDING";
  }

  canCancel(): boolean {
    const status = this.promise()?.status ?? "";
    return ["DRAFT", "AWAITING_FUNDING", "FUNDED", "SUBMITTED", "REJECTED_RETRY", "NEEDS_REVIEW", "APPROVED"].includes(status);
  }

  add(): void {
    this.draft.update((items) => [...items, { text: "", weight: 0.2, required: true }]);
  }

  remove(index: number): void {
    this.draft.update((items) => items.filter((_, itemIndex) => itemIndex !== index));
  }

  save(confirm: boolean): void {
    const current = this.promise();
    if (!current) return;
    const items = this.draft().map((item) => ({ text: item.text.trim(), weight: Number(item.weight), required: item.required }));
    if (!items.length) {
      this.toast.error("Add at least one checklist item.");
      return;
    }
    if (items.some((item) => item.text.length < 3 || !(item.weight > 0))) {
      this.toast.error("Each item needs a short description and a weight above 0.");
      return;
    }
    this.api.saveChecklist(current.id, {
      items,
      pass_threshold: current.pass_threshold,
      confirm,
    }).subscribe({
      next: (promise) => {
        this.promise.set(promise);
        this.draft.set(promise.checklist.map((item) => ({ ...item })));
        this.toast.success(confirm ? "Checklist confirmed. You can fund the promise now." : "Checklist draft saved.");
        setTimeout(() => this.mountPayPal());
      },
    });
  }

  cancel(): void {
    const current = this.promise();
    if (!current) return;
    this.api.cancel(current.id).subscribe({
      next: (promise) => {
        this.promise.set(promise);
        this.toast.info("The promise was cancelled and any hold was released.");
      },
    });
  }

  retryPay(): void {
    const current = this.promise();
    if (!current) return;
    this.api.settle(current.id).subscribe({
      next: (promise) => {
        this.promise.set(promise);
        if (promise.status === "PAID") this.toast.success("The worker has been paid.");
        else if (promise.status === "PAYMENT_FAILED") this.toast.error(promise.status_detail ?? "Payout failed. Try again in a moment.");
        else this.toast.info(promise.status_detail ?? "PayPal is still processing the payout.");
      },
    });
  }

  private reload(): void {
    const id = this.route.snapshot.paramMap.get("id") ?? "";
    this.api.get(id).subscribe({
      next: (promise) => {
        this.promise.set(promise);
        if (!this.draft().length) this.draft.set(promise.checklist.map((item) => ({ ...item })));
        setTimeout(() => this.mountPayPal());
      },
    });
    this.api.verifications(id).subscribe({
      next: (result) => this.verifications.set(result.verifications),
    });
  }

  private mountPayPal(): void {
    const host = this.paypalHost()?.nativeElement;
    const current = this.promise();
    if (!host || !current || current.status !== "AWAITING_FUNDING" || this.paypalReady) return;
    this.api.config().subscribe({
      next: async (config) => {
        try {
        if (!config.paypal_client_id) {
          this.toast.error("Add PAYPAL_CLIENT_ID to the environment before funding.");
          return;
        }
        if (!window.paypal && document.getElementById("paypal-sdk")) return;
        if (!window.paypal) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.id = "paypal-sdk";
            script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypal_client_id)}&intent=authorize&currency=USD`;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("PayPal Buttons could not load."));
            document.body.appendChild(script);
          });
        }
        if (!window.paypal || this.paypalReady) return;
        this.paypalReady = true;
        await window.paypal.Buttons({
          createOrder: async () => {
            const order = await new Promise<{ order_id: string }>((resolve, reject) => {
              this.api.fund(current.id).subscribe({ next: resolve, error: reject });
            });
            return order.order_id;
          },
          onApprove: async () => {
            const updated = await new Promise<PromiseView>((resolve, reject) => {
              this.api.confirmFund(current.id).subscribe({ next: resolve, error: reject });
            });
            this.promise.set(updated);
            this.toast.success("PayPal hold authorized. Money is held until the work passes.");
          },
          onError: () => this.toast.error("PayPal could not authorize the hold."),
        }).render(host);
        } catch (error) {
          const message = error instanceof Error ? error.message : "PayPal could not load.";
          this.toast.error(message);
        }
      },
    });
  }

  ngOnDestroy(): void {
    this.source?.close();
  }
}
