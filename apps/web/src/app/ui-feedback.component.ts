import { Component, inject } from "@angular/core";
import { LoadingService } from "./loading.service";
import { ToastService } from "./toast.service";

@Component({
  selector: "app-ui-feedback",
  template: `
    @if (loading.active()) {
      <div class="progress-host" aria-hidden="true">
        <div class="progress-bar"></div>
      </div>
    }
    <div class="toast-host" aria-live="polite" aria-relevant="additions">
      @for (item of toast.toasts(); track item.id) {
        <div class="toast" [class]="'toast ' + item.kind" role="status">
          <span>{{ item.message }}</span>
          <button type="button" class="toast-close" (click)="toast.dismiss(item.id)" aria-label="Dismiss">×</button>
        </div>
      }
    </div>
  `,
})
export class UiFeedbackComponent {
  readonly loading = inject(LoadingService);
  readonly toast = inject(ToastService);
}
