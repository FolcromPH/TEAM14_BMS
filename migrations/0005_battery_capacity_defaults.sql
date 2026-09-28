UPDATE battery_specs
SET voltage_v = 12,
    capacity_mah = CASE slot
      WHEN 1 THEN 10000
      WHEN 2 THEN 2200
    END
WHERE updated_at_ms = 0;