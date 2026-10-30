import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  AgStudioAiModule,
  AgStudioModuleRegistry,
  createAiHarness,
  createStudio,
  type AgDataSourcesDefinition,
  type AgReportState,
  type AgStudioApi,
  type AgStudioStateUpdatedEvent,
} from "ag-studio";
import { ApiService } from "../api.service";
import { ToastService } from "../toast.service";
import { DASHBOARD_INITIAL_STATE } from "../studio/dashboard-initial-state";
import { buildStudioData } from "../studio/studio-data";
import { createStudioProxyAdapter } from "../studio/studio-ai-adapter";

const STATE_KEY = "pp_ag_studio_state";

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

@Component({
  selector: "app-dashboard",
  imports: [RouterLink],
  template: `
    <section class="dashboard-page stack">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <h1>Operations dashboard</h1>
          <p class="lede">
            AG Studio analytics over your PayPal holds, payouts, and AI verification logs.
            Use the assistant to add widgets, or switch to edit mode to rearrange the layout.
          </p>
        </div>
        <div class="row">
          <button class="secondary" type="button" (click)="refresh()">Refresh data</button>
          <button class="secondary" type="button" (click)="toggleMode()">
            {{ mode() === 'view' ? 'Edit layout' : 'Lock layout' }}
          </button>
          <button class="secondary" type="button" (click)="resetLayout()">Reset layout</button>
          <a routerLink="/">Back to list</a>
        </div>
      </div>
      @if (loadError()) {
        <p class="note">{{ loadError() }}</p>
      }
      <div class="studio-host" #studioHost></div>
    </section>
  `,
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  @ViewChild("studioHost") studioHost?: ElementRef<HTMLElement>;

  private studioApi?: AgStudioApi;
  private dataPayload: AgDataSourcesDefinition | null = null;
  private initialStateValue: AgReportState = this.readSavedState() ?? DASHBOARD_INITIAL_STATE;

  readonly mode = signal<"view" | "edit">("view");
  readonly loadError = signal("");

  ngAfterViewInit(): void {
    this.refresh();
  }

  ngOnDestroy(): void {
    this.studioApi?.destroy();
  }

  refresh(): void {
    this.api.studioData().subscribe({
      next: (payload) => {
        this.dataPayload = buildStudioData(payload);
        this.loadError.set("");
        this.mountStudio();
      },
      error: (error: Error) => {
        this.loadError.set(error.message);
      },
    });
  }

  toggleMode(): void {
    this.mode.set(this.mode() === "view" ? "edit" : "view");
    this.studioApi?.setProperty("mode", this.mode());
  }

  resetLayout(): void {
    localStorage.removeItem(STATE_KEY);
    this.initialStateValue = structuredClone(DASHBOARD_INITIAL_STATE);
    this.toast.info("Dashboard layout reset to the default report.");
    this.mountStudio(true);
  }

  private mountStudio(recreate = false): void {
    const host = this.studioHost?.nativeElement;
    if (!host || !this.dataPayload) return;
    if (recreate && this.studioApi) {
      this.studioApi.destroy();
      this.studioApi = undefined;
      host.replaceChildren();
    }
    if (this.studioApi) {
      this.studioApi.updateProperties({ data: this.dataPayload });
      this.studioApi.reload();
      return;
    }

    this.studioApi = createStudio(
      host,
      {
        data: this.dataPayload,
        initialState: this.initialStateValue,
        mode: this.mode(),
        enableFilterEditingInViewMode: true,
        ai: ({ api }: { api: AgStudioApi }) =>
          createAiHarness(api, {
            adapter: createStudioProxyAdapter(() => sessionStorage.getItem("pp_token")),
            primary: "lead",
            promptStarters: [
              { label: "Amount by status", prompt: "Add a bar chart of total amount_dollars grouped by status_label." },
              { label: "Review queue", prompt: "Show a grid of promises where needs_review is 1." },
              { label: "Failed items", prompt: "Chart verification_items where passed is No." },
            ],
          }),
        onStateUpdated: (event: AgStudioStateUpdatedEvent) => this.onStateUpdated(event),
      },
      { modules: [AgStudioAiModule] },
    );
  }

  private onStateUpdated(event: AgStudioStateUpdatedEvent): void {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(event.state));
    } catch {
      // ignore quota errors
    }
  }

  private readSavedState(): AgReportState | null {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as AgReportState;
    } catch {
      return null;
    }
  }
}
