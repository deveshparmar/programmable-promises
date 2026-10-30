import { Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService } from "../api.service";
import { money, pillClass, statusLabel, type PromiseView } from "../models";

const PAGE_SIZE = 10;

@Component({
  selector: "app-list",
  imports: [RouterLink],
  template: `
    <section class="stack">
      <div class="row" style="justify-content: space-between;">
        <div>
          <h1>Your promises</h1>
          <p class="lede">Money stays held until the photo passes, you approve it, or the deadline releases the hold.</p>
        </div>
        <div class="row">
          <a class="secondary" routerLink="/dashboard">Dashboard</a>
          <a class="primary" routerLink="/new">New promise</a>
        </div>
      </div>
      @if (loaded() && total() === 0) {
        <div class="card"><p>No promises yet. Create one and fund it in the PayPal sandbox.</p></div>
      }
      <div class="list">
        @for (promise of promises(); track promise.id) {
          <a class="card promise-link" [routerLink]="['/promises', promise.id]">
            <div>
              <strong>{{ promise.title }}</strong>
              <div class="muted">{{ promise.worker_email }}</div>
            </div>
            <div>
              <div class="money">{{ money(promise.amount_minor) }}</div>
              <span [class]="pillClass(promise.status)">{{ statusLabel(promise.status) }}</span>
            </div>
          </a>
        }
      </div>
      @if (totalPages() > 1) {
        <nav class="pagination row" aria-label="Promise pages">
          <button class="secondary" type="button" (click)="goPrev()" [disabled]="page() <= 1 || loading()">
            Previous
          </button>
          <span class="muted pagination-meta">
            Page {{ page() }} of {{ totalPages() }}
            <span class="pagination-count">({{ total() }} total)</span>
          </span>
          <button class="secondary" type="button" (click)="goNext()" [disabled]="page() >= totalPages() || loading()">
            Next
          </button>
        </nav>
      }
    </section>
  `,
})
export class ListComponent {
  private readonly api = inject(ApiService);
  readonly promises = signal<PromiseView[]>([]);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly page = signal(1);
  readonly total = signal(0);
  readonly totalPages = signal(0);
  readonly money = money;
  readonly statusLabel = statusLabel;
  readonly pillClass = pillClass;

  constructor() {
    this.loadPage(1);
  }

  goPrev(): void {
    if (this.page() > 1) this.loadPage(this.page() - 1);
  }

  goNext(): void {
    if (this.page() < this.totalPages()) this.loadPage(this.page() + 1);
  }

  private loadPage(page: number): void {
    this.loading.set(true);
    this.api.listPage(page, PAGE_SIZE).subscribe({
      next: (result) => {
        this.promises.set(result.items);
        this.page.set(result.page);
        this.total.set(result.total);
        this.totalPages.set(result.total_pages);
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: () => {
        this.loaded.set(true);
        this.loading.set(false);
      },
    });
  }
}
