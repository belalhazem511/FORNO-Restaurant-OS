import { db } from "@/lib/db";
import { protectedProcedure, router } from "../init";
import { z } from "zod/v4";

export const restaurantRouter = router({
  model: protectedProcedure.input(z.void()).query(async () => {
    return db.query.branches.findMany({
      with: {
        diningAreas: { with: { tables: true } },
        kitchenStations: true,
        menuCategories: {
          with: {
            menuItems: {
              with: {
                product: { columns: { image_key: true } },
                variants: true,
                kitchenStation: true,
                modifierGroups: {
                  with: {
                    modifierGroup: { with: { options: true } },
                  },
                },
              },
            },
          },
        },
        modifierGroups: { with: { options: true } },
      },
    });
  }),
});
