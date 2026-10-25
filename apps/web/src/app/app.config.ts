import { HttpErrorResponse, HttpInterceptorFn, provideHttpClient, withInterceptors } from "@angular/common/http";
import { ApplicationConfig, inject } from "@angular/core";
import { provideRouter } from "@angular/router";
import { catchError, finalize, throwError } from "rxjs";
import { SHARE_TOKEN, SKIP_PAYER_AUTH } from "./api.service";
import { routes } from "./app.routes";
import { LoadingService } from "./loading.service";
import { ToastService } from "./toast.service";

const authInterceptor: HttpInterceptorFn = (req, next) => {
  const shareToken = req.context.get(SHARE_TOKEN);
  const payerToken = req.context.get(SKIP_PAYER_AUTH) ? null : sessionStorage.getItem("pp_token");
  if (!shareToken && !payerToken) return next(req);
  return next(req.clone({
    setHeaders: {
      ...(shareToken ? { "X-Share-Token": shareToken } : {}),
      ...(payerToken ? { Authorization: `Bearer ${payerToken}` } : {}),
    },
  }));
};

const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  const loading = inject(LoadingService);
  loading.begin();
  return next(req).pipe(finalize(() => loading.end()));
};

const errorToastInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      const message =
        error.error?.error?.message ??
        (error.status === 0 ? "Cannot reach the server. Is the API running?" : error.message || "The request failed.");
      toast.error(message);
      return throwError(() => new Error(message));
    }),
  );
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor, loadingInterceptor, errorToastInterceptor])),
  ],
};
