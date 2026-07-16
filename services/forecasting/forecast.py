"""
Vyaapaar-Core — Stock Forecasting Service
=========================================

FastAPI microservice that turns a retailer's daily sales history into:

  * a day-by-day demand forecast (with confidence bounds),
  * a predicted out-of-stock date,
  * a Safety Stock index, and
  * a recommended bulk order quantity (rounded to distributor pack size).

Model: Facebook Prophet with weekly + yearly seasonality and an explicit
Indian retail holiday frame (Diwali, Holi, Eid, Raksha Bandhan, Navratri /
Dussehra, and wedding-season windows). Falls back to a weighted moving
average when the history is too sparse for Prophet to be trustworthy.

Run:  uvicorn forecast:app --host 0.0.0.0 --port 8100
"""

from __future__ import annotations

import logging
import math
from datetime import date, timedelta
from typing import Optional

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

try:
    from prophet import Prophet

    PROPHET_AVAILABLE = True
except ImportError:  # pragma: no cover - degraded mode for slim deployments
    PROPHET_AVAILABLE = False

logger = logging.getLogger("vyaapaar.forecast")

ROLLING_WINDOW_DAYS = 90        # modelling window mandated by product spec
FORECAST_HORIZON_DAYS = 45      # how far ahead we project
MIN_SALE_DAYS_FOR_PROPHET = 14  # below this, Prophet overfits; use fallback

# z-scores for common service levels (P(no stockout during lead time))
Z_SCORES = {0.80: 0.842, 0.85: 1.036, 0.90: 1.282, 0.95: 1.645, 0.98: 2.054, 0.99: 2.326}


# ---------------------------------------------------------------------------
# Indian retail holiday frame (observed dates, 2024–2027)
# lower_window/upper_window capture pre-festival stock-up and post-festival lull.
# ---------------------------------------------------------------------------
def indian_retail_holidays() -> pd.DataFrame:
    festivals = {
        "diwali": (["2024-11-01", "2025-10-21", "2026-11-08", "2027-10-29"], -10, 2),
        "dhanteras": (["2024-10-29", "2025-10-18", "2026-11-06", "2027-10-27"], -3, 1),
        "holi": (["2024-03-25", "2025-03-14", "2026-03-04", "2027-03-22"], -4, 1),
        "raksha_bandhan": (["2024-08-19", "2025-08-09", "2026-08-28", "2027-08-17"], -3, 0),
        "eid_ul_fitr": (["2024-04-11", "2025-03-31", "2026-03-20", "2027-03-10"], -7, 1),
        "dussehra": (["2024-10-12", "2025-10-02", "2026-10-20", "2027-10-09"], -5, 1),
        "navratri_start": (["2024-10-03", "2025-09-22", "2026-10-11", "2027-09-30"], -2, 8),
        "republic_day": (["2024-01-26", "2025-01-26", "2026-01-26", "2027-01-26"], -1, 0),
        "independence_day": (["2024-08-15", "2025-08-15", "2026-08-15", "2027-08-15"], -1, 0),
    }
    frames = [
        pd.DataFrame(
            {
                "holiday": name,
                "ds": pd.to_datetime(dates),
                "lower_window": lower,
                "upper_window": upper,
            }
        )
        for name, (dates, lower, upper) in festivals.items()
    ]

    # Wedding seasons drive sustained demand in staples/FMCG. Modelled as
    # weekly anchor points across the auspicious windows (Nov–mid-Feb, mid-Apr–Jun).
    wedding_anchors = []
    for year in range(2024, 2028):
        winter = pd.date_range(f"{year}-11-15", f"{year + 1}-02-15", freq="7D")
        summer = pd.date_range(f"{year}-04-15", f"{year}-06-30", freq="7D")
        wedding_anchors.extend(list(winter) + list(summer))
    frames.append(
        pd.DataFrame(
            {"holiday": "wedding_season", "ds": wedding_anchors, "lower_window": -2, "upper_window": 4}
        )
    )
    return pd.concat(frames, ignore_index=True)


HOLIDAYS_DF = indian_retail_holidays()


# ---------------------------------------------------------------------------
# API contracts
# ---------------------------------------------------------------------------
class SalesRecord(BaseModel):
    sale_date: date = Field(..., description="Calendar day of the sales total")
    units_sold: float = Field(..., ge=0, description="Total units sold that day")


class ForecastRequest(BaseModel):
    sku: str = Field(..., min_length=1, max_length=64)
    product_name: Optional[str] = None
    current_stock: float = Field(..., ge=0)
    supplier_lead_time_days: int = Field(default=3, ge=0, le=60)
    review_period_days: int = Field(default=7, ge=1, le=30, description="How often the shopkeeper reorders")
    service_level: float = Field(default=0.95, description="Target in-stock probability")
    pack_size: int = Field(default=1, ge=1, description="Distributor case size; order qty is rounded up to this")
    history: list[SalesRecord] = Field(..., min_length=1)

    @field_validator("service_level")
    @classmethod
    def _known_service_level(cls, v: float) -> float:
        if v not in Z_SCORES:
            raise ValueError(f"service_level must be one of {sorted(Z_SCORES)}")
        return v


class ForecastPoint(BaseModel):
    forecast_date: date
    predicted_units: float
    lower_bound: float
    upper_bound: float


class ForecastResponse(BaseModel):
    sku: str
    model_used: str                      # "prophet" | "weighted_moving_average"
    current_stock: float
    daily_demand_mean: float
    daily_demand_std: float
    predicted_out_of_stock_date: Optional[date]
    days_until_stockout: Optional[int]
    safety_stock: float                  # units to hold as buffer
    safety_stock_index: float            # current_stock / (safety_stock + lead-time demand); <1 = danger
    reorder_point: float                 # trigger level in units
    recommended_order_qty: int           # units, rounded up to pack_size
    forecast: list[ForecastPoint]


# ---------------------------------------------------------------------------
# Modelling
# ---------------------------------------------------------------------------
def _prepare_history(history: list[SalesRecord]) -> pd.DataFrame:
    """Aggregate to daily grain, clamp to the rolling window, and fill gap days
    with zero sales (a kirana that sold nothing still generates signal)."""
    df = pd.DataFrame([{"ds": r.sale_date, "y": r.units_sold} for r in history])
    df["ds"] = pd.to_datetime(df["ds"])
    df = df.groupby("ds", as_index=False)["y"].sum().sort_values("ds")

    cutoff = df["ds"].max() - pd.Timedelta(days=ROLLING_WINDOW_DAYS - 1)
    df = df[df["ds"] >= cutoff]

    full_range = pd.date_range(df["ds"].min(), df["ds"].max(), freq="D")
    df = df.set_index("ds").reindex(full_range, fill_value=0.0).rename_axis("ds").reset_index()
    return df


def _forecast_prophet(df: pd.DataFrame) -> pd.DataFrame:
    model = Prophet(
        holidays=HOLIDAYS_DF,
        weekly_seasonality=True,
        yearly_seasonality=True,
        daily_seasonality=False,
        seasonality_mode="multiplicative",
        interval_width=0.80,
    )
    model.fit(df)
    future = model.make_future_dataframe(periods=FORECAST_HORIZON_DAYS, freq="D")
    fcst = model.predict(future).tail(FORECAST_HORIZON_DAYS)
    out = fcst[["ds", "yhat", "yhat_lower", "yhat_upper"]].copy()
    # Demand cannot be negative.
    for col in ("yhat", "yhat_lower", "yhat_upper"):
        out[col] = out[col].clip(lower=0.0)
    return out


def _forecast_moving_average(df: pd.DataFrame) -> pd.DataFrame:
    """Fallback: recency-weighted moving average with a flat horizon."""
    recent = df.tail(28)["y"]
    weights = pd.Series(range(1, len(recent) + 1), index=recent.index, dtype=float)
    mean = float((recent * weights).sum() / weights.sum()) if len(recent) else 0.0
    std = float(recent.std(ddof=0)) if len(recent) > 1 else 0.0

    start = df["ds"].max() + pd.Timedelta(days=1)
    dates = pd.date_range(start, periods=FORECAST_HORIZON_DAYS, freq="D")
    return pd.DataFrame(
        {
            "ds": dates,
            "yhat": mean,
            "yhat_lower": max(mean - 1.282 * std, 0.0),
            "yhat_upper": mean + 1.282 * std,
        }
    )


def _stockout_date(fcst: pd.DataFrame, current_stock: float) -> Optional[date]:
    """First forecast day on which cumulative expected demand exhausts stock."""
    cumulative = fcst["yhat"].cumsum()
    exhausted = fcst.loc[cumulative >= current_stock, "ds"]
    if exhausted.empty:
        return None
    return exhausted.iloc[0].date()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Vyaapaar-Core Forecasting Service",
    version="1.0.0",
    description="Prophet-based stock depletion forecasting for Indian retail.",
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "prophet_available": PROPHET_AVAILABLE}


@app.post("/v1/forecast/stock", response_model=ForecastResponse)
def forecast_stock(req: ForecastRequest) -> ForecastResponse:
    df = _prepare_history(req.history)
    sale_days = int((df["y"] > 0).sum())

    use_prophet = PROPHET_AVAILABLE and sale_days >= MIN_SALE_DAYS_FOR_PROPHET
    try:
        fcst = _forecast_prophet(df) if use_prophet else _forecast_moving_average(df)
        model_used = "prophet" if use_prophet else "weighted_moving_average"
    except Exception:  # Prophet can fail on degenerate series; degrade gracefully
        logger.exception("Prophet failed for sku=%s; falling back to moving average", req.sku)
        fcst = _forecast_moving_average(df)
        model_used = "weighted_moving_average"

    demand_mean = float(fcst["yhat"].mean())
    # Prefer observed variability over model variability for the safety buffer.
    observed_std = float(df["y"].std(ddof=0)) if len(df) > 1 else 0.0
    demand_std = observed_std if observed_std > 0 else float(fcst["yhat"].std(ddof=0) or 0.0)

    z = Z_SCORES[req.service_level]
    lead = req.supplier_lead_time_days
    safety_stock = z * demand_std * math.sqrt(max(lead, 1))
    lead_time_demand = demand_mean * lead
    reorder_point = lead_time_demand + safety_stock

    # Order enough to cover lead time + one review period, plus the buffer,
    # net of what is already on the shelf.
    coverage_demand = demand_mean * (lead + req.review_period_days)
    raw_order = max(coverage_demand + safety_stock - req.current_stock, 0.0)
    recommended_order_qty = int(math.ceil(raw_order / req.pack_size) * req.pack_size) if raw_order > 0 else 0

    oos_date = _stockout_date(fcst, req.current_stock)
    days_until = (oos_date - date.today()).days if oos_date else None

    denominator = reorder_point if reorder_point > 0 else 1.0
    safety_stock_index = round(req.current_stock / denominator, 3)

    if demand_mean <= 0 and req.current_stock <= 0:
        raise HTTPException(status_code=422, detail="No demand signal and no stock: nothing to forecast.")

    return ForecastResponse(
        sku=req.sku,
        model_used=model_used,
        current_stock=req.current_stock,
        daily_demand_mean=round(demand_mean, 3),
        daily_demand_std=round(demand_std, 3),
        predicted_out_of_stock_date=oos_date,
        days_until_stockout=days_until,
        safety_stock=round(safety_stock, 2),
        safety_stock_index=safety_stock_index,
        reorder_point=round(reorder_point, 2),
        recommended_order_qty=recommended_order_qty,
        forecast=[
            ForecastPoint(
                forecast_date=row.ds.date(),
                predicted_units=round(float(row.yhat), 3),
                lower_bound=round(float(row.yhat_lower), 3),
                upper_bound=round(float(row.yhat_upper), 3),
            )
            for row in fcst.itertuples()
        ],
    )
