import { Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService } from "../api.service";
import { money, pillClass, statusLabel, type PromiseView } from "../models";

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
        <a class="primary" routerLink="/new">New promise</a>
      </div>
      @if (!promises().length && loaded()) {
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
    </section>
  `,
})
export class ListComponent {
  private readonly api = inject(ApiService);
  readonly promises = signal<PromiseView[]>([]);
  readonly loaded = signal(false);
  readonly money = money;
  readonly statusLabel = statusLabel;
  readonly pillClass = pillClass;

  constructor() {
    this.api.list().subscribe({
      next: (promises) => {
        this.promises.set(promises);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }
}
