# Create a mute timing for weekend market closing hours
# (Friday 21:00 UTC to Sunday 23:00 UTC, plus the Sunday 23:00 reopen-grace hour).
# This prevents oracle-relayer stale-price alerts for FX feeds from paging while
# market data is expected to be paused.
resource "grafana_mute_timing" "weekend_mute" {
  name = "Weekend Market Closing Hours"

  intervals {
    times {
      start = "21:00"
      end   = "24:00"
    }
    weekdays = ["friday"]
    location = "UTC"
  }

  intervals {
    weekdays = ["saturday"]
    location = "UTC"
  }

  intervals {
    times {
      start = "00:00"
      end   = "24:00"
    }
    weekdays = ["sunday"]
    location = "UTC"
  }
}
