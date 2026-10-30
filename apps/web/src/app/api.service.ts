import { HttpClient, HttpContext, HttpContextToken, HttpErrorResponse } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable, throwError } from "rxjs";
import { catchError } from "rxjs/operators";
import type { PromiseView, Verification } from "./models";

export const SHARE_TOKEN = new HttpContextToken<string | null>(() => null);
export const SKIP_PAYER_AUTH = new HttpContextToken(() => false);

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);

  login(email: string): Observable<{ token: string; email: string; name: string }> {
    return this.http.post<{ token: string; email: string; name: string }>("/api/auth/login", { email }, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
    }).pipe(catchError(this.asError));
  }

  config(): Observable<{ paypal_client_id: string }> {
    return this.http.get<{ paypal_client_id: string }>("/api/config").pipe(catchError(this.asError));
  }

  list(): Observable<PromiseView[]> {
    return this.http.get<PromiseView[]>("/api/promises").pipe(catchError(this.asError));
  }

  listPage(page: number, limit = 10): Observable<{
    items: PromiseView[];
    total: number;
    page: number;
    limit: number;
    total_pages: number;
  }> {
    return this.http
      .get<{ items: PromiseView[]; total: number; page: number; limit: number; total_pages: number }>(
        "/api/promises",
        { params: { page: String(page), limit: String(limit) } },
      )
      .pipe(catchError(this.asError));
  }

  studioData(): Observable<{ promises: Record<string, unknown>[]; verification_items: Record<string, unknown>[] }> {
    return this.http
      .get<{ promises: Record<string, unknown>[]; verification_items: Record<string, unknown>[] }>(
        "/api/analytics/studio-data",
      )
      .pipe(catchError(this.asError));
  }

  create(body: unknown): Observable<PromiseView> {
    return this.write("post", "/api/promises", body);
  }

  get(id: string, shareToken?: string): Observable<PromiseView> {
    return this.http.get<PromiseView>(`/api/promises/${id}`, { context: this.workerContext(shareToken) }).pipe(catchError(this.asError));
  }

  saveChecklist(id: string, body: unknown): Observable<PromiseView> {
    return this.write("put", `/api/promises/${id}/checklist`, body);
  }

  fund(id: string): Observable<{ order_id: string }> {
    return this.write("post", `/api/promises/${id}/fund`, {});
  }

  confirmFund(id: string): Observable<PromiseView> {
    return this.write("post", `/api/promises/${id}/fund/confirm`, {});
  }

  challenge(id: string, shareToken: string): Observable<{ challenge_code: string }> {
    return this.write("post", `/api/promises/${id}/challenge`, {}, shareToken);
  }

  submit(id: string, shareToken: string, file: File): Observable<{
    verdict: string;
    score: number | null;
    status: string;
    workerFeedback: string;
    items: { text: string; passed: boolean; evidence: string }[];
  }> {
    const data = new FormData();
    data.append("file", file);
    return this.http.post<{
      verdict: string;
      score: number | null;
      status: string;
      workerFeedback: string;
      items: { text: string; passed: boolean; evidence: string }[];
    }>(`/api/promises/${id}/submissions`, data, {
      headers: { "Idempotency-Key": crypto.randomUUID(), "X-Share-Token": shareToken },
      context: new HttpContext().set(SKIP_PAYER_AUTH, true),
    }).pipe(catchError(this.asError));
  }

  verifications(id: string, shareToken?: string): Observable<{ verifications: Verification[] }> {
    return this.http.get<{ verifications: Verification[] }>(`/api/promises/${id}/verifications`, {
      context: this.workerContext(shareToken),
    }).pipe(catchError(this.asError));
  }

  review(id: string, body: unknown): Observable<PromiseView> {
    return this.write("post", `/api/promises/${id}/review`, body);
  }

  cancel(id: string): Observable<PromiseView> {
    return this.write("post", `/api/promises/${id}/cancel`, {});
  }

  settle(id: string): Observable<PromiseView> {
    return this.write("post", `/api/promises/${id}/settle`, {});
  }

  private write<T>(method: "post" | "put", url: string, body: unknown, shareToken?: string): Observable<T> {
    return this.http.request<T>(method, url, {
      body,
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        ...(shareToken ? { "X-Share-Token": shareToken } : {}),
      },
      context: this.workerContext(shareToken),
    }).pipe(catchError(this.asError));
  }

  private workerContext(shareToken?: string): HttpContext {
    let context = new HttpContext();
    if (shareToken) context = context.set(SHARE_TOKEN, shareToken).set(SKIP_PAYER_AUTH, true);
    return context;
  }

  private asError(error: HttpErrorResponse): Observable<never> {
    const message = error.error?.error?.message ?? "The request failed.";
    return throwError(() => new Error(message));
  }
}
