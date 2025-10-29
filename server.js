const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// MongoDB Connection with better error handling
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/countries_db";

mongoose
  .connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    console.error(
      "Make sure MongoDB is running or MONGODB_URI is correct in .env"
    );
  });

// Country Schema
const countrySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    capital: String,
    region: String,
    population: { type: Number, required: true },
    currency_code: String,
    exchange_rate: Number,
    estimated_gdp: Number,
    flag_url: String,
    last_refreshed_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

countrySchema.index({ region: 1 });
countrySchema.index({ currency_code: 1 });
countrySchema.index({ estimated_gdp: -1 });
countrySchema.index({ name: 1 });

const Country = mongoose.model("Country", countrySchema);

// Metadata Schema
const metadataSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  last_refreshed_at: Date,
  total_countries: { type: Number, default: 0 },
});

const Metadata = mongoose.model("Metadata", metadataSchema);

// Generate summary image - with optional Jimp
async function generateSummaryImage(totalCountries, topCountries, timestamp) {
  try {
    // Try to load Jimp
    let Jimp;
    try {
      Jimp = require("jimp");
    } catch (e) {
      console.log("Jimp not installed, skipping image generation");
      return;
    }

    const width = 800;
    const height = 600;

    const image = new Jimp(width, height, "#1a1a2e");

    const fontLarge = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const fontMedium = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_14_WHITE);

    image.print(
      fontLarge,
      0,
      40,
      {
        text: "Country Data Summary",
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      },
      width
    );

    image.print(
      fontMedium,
      0,
      100,
      {
        text: `Total Countries: ${totalCountries}`,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      },
      width
    );

    image.print(
      fontLarge,
      0,
      160,
      {
        text: "Top 5 Countries by GDP",
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      },
      width
    );

    let yPos = 220;
    for (let i = 0; i < Math.min(topCountries.length, 5); i++) {
      const country = topCountries[i];
      const gdpFormatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(country.estimated_gdp);

      image.print(
        fontMedium,
        80,
        yPos,
        `${i + 1}. ${country.name} - ${gdpFormatted}`
      );
      yPos += 45;
    }

    image.print(
      fontSmall,
      0,
      height - 60,
      {
        text: `Last Updated: ${new Date(timestamp).toLocaleString()}`,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      },
      width
    );

    const cacheDir = path.join(__dirname, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await image.writeAsync(path.join(cacheDir, "summary.png"));

    console.log("✅ Summary image generated");
  } catch (error) {
    console.error("Image generation failed:", error.message);
  }
}

// Health check - must be first
app.get("/", (req, res) => {
  res.json({
    message: "Country Currency & Exchange API",
    status: "running",
    timestamp: new Date().toISOString(),
  });
});

// GET /status - must come before /:name routes
app.get("/status", async (req, res) => {
  try {
    let metadata = await Metadata.findById("global");

    if (!metadata) {
      const count = await Country.countDocuments();
      return res.json({
        total_countries: count,
        last_refreshed_at: null,
      });
    }

    res.json({
      total_countries: metadata.total_countries,
      last_refreshed_at: metadata.last_refreshed_at,
    });
  } catch (error) {
    console.error("Error fetching status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/image - must come before /:name
app.get("/countries/image", async (req, res) => {
  try {
    const imagePath = path.join(__dirname, "cache", "summary.png");
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch (error) {
    res.status(404).json({ error: "Summary image not found" });
  }
});

// POST /countries/refresh
app.post("/countries/refresh", async (req, res) => {
  try {
    console.log("Starting refresh...");

    // Fetch countries data
    let countriesData;
    try {
      console.log("Fetching countries...");
      const countriesResponse = await axios.get(
        "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies",
        { timeout: 15000 }
      );
      countriesData = countriesResponse.data;
      console.log(`Fetched ${countriesData.length} countries`);
    } catch (error) {
      console.error("Countries API error:", error.message);
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from restcountries.com",
      });
    }

    // Fetch exchange rates
    let exchangeRates;
    try {
      console.log("Fetching exchange rates...");
      const ratesResponse = await axios.get(
        "https://open.er-api.com/v6/latest/USD",
        { timeout: 15000 }
      );
      exchangeRates = ratesResponse.data.rates;
      console.log(
        `Fetched ${Object.keys(exchangeRates).length} exchange rates`
      );
    } catch (error) {
      console.error("Exchange rates API error:", error.message);
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from open.er-api.com",
      });
    }

    // Process countries in batches
    console.log("Processing countries...");
    const batchSize = 50;
    let processedCount = 0;

    for (let i = 0; i < countriesData.length; i += batchSize) {
      const batch = countriesData.slice(i, i + batchSize);
      const operations = [];

      for (const country of batch) {
        const name = country.name;
        const capital = country.capital || null;
        const region = country.region || null;
        const population = country.population || 0;
        const flagUrl = country.flag || null;

        let currencyCode = null;
        let exchangeRate = null;
        let estimatedGdp = null;

        if (country.currencies && country.currencies.length > 0) {
          currencyCode = country.currencies[0].code;

          if (currencyCode && exchangeRates[currencyCode]) {
            exchangeRate = exchangeRates[currencyCode];
            const randomMultiplier = Math.random() * (2000 - 1000) + 1000;
            estimatedGdp = (population * randomMultiplier) / exchangeRate;
          }
        } else {
          estimatedGdp = 0;
        }

        operations.push({
          updateOne: {
            filter: { name: name },
            update: {
              $set: {
                name,
                capital,
                region,
                population,
                currency_code: currencyCode,
                exchange_rate: exchangeRate,
                estimated_gdp: estimatedGdp,
                flag_url: flagUrl,
                last_refreshed_at: new Date(),
              },
            },
            upsert: true,
          },
        });
      }

      if (operations.length > 0) {
        await Country.bulkWrite(operations, { ordered: false });
        processedCount += operations.length;
        console.log(
          `Processed ${processedCount}/${countriesData.length} countries`
        );
      }
    }

    // Update metadata
    const totalCountries = await Country.countDocuments();
    const now = new Date();

    await Metadata.findByIdAndUpdate(
      "global",
      {
        last_refreshed_at: now,
        total_countries: totalCountries,
      },
      { upsert: true, new: true }
    );

    console.log("Refresh complete, generating image...");

    // Get top countries for image
    const topCountries = await Country.find({
      estimated_gdp: { $ne: null, $gt: 0 },
    })
      .sort({ estimated_gdp: -1 })
      .limit(5)
      .lean();

    // Generate image (non-blocking)
    generateSummaryImage(totalCountries, topCountries, now.toISOString()).catch(
      (err) => {
        console.error("Image generation error:", err.message);
      }
    );

    res.json({
      message: "Countries data refreshed successfully",
      total_countries: totalCountries,
      last_refreshed_at: now,
    });
  } catch (error) {
    console.error("Error refreshing countries:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// GET /countries
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;

    const query = {};

    if (region) {
      query.region = new RegExp(`^${region}$`, "i");
    }

    if (currency) {
      query.currency_code = currency.toUpperCase();
    }

    let sortOption = { name: 1 };

    if (sort === "gdp_desc") {
      sortOption = { estimated_gdp: -1 };
    } else if (sort === "gdp_asc") {
      sortOption = { estimated_gdp: 1 };
    } else if (sort === "population_desc") {
      sortOption = { population: -1 };
    } else if (sort === "population_asc") {
      sortOption = { population: 1 };
    }

    const countries = await Country.find(query)
      .sort(sortOption)
      .select("-__v -createdAt -updatedAt")
      .lean();

    res.json(countries);
  } catch (error) {
    console.error("Error fetching countries:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/:name
app.get("/countries/:name", async (req, res) => {
  try {
    const country = await Country.findOne({
      name: new RegExp(`^${req.params.name}$`, "i"),
    })
      .select("-__v -createdAt -updatedAt")
      .lean();

    if (!country) {
      return res.status(404).json({ error: "Country not found" });
    }

    res.json(country);
  } catch (error) {
    console.error("Error fetching country:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /countries/:name
app.delete("/countries/:name", async (req, res) => {
  try {
    const result = await Country.deleteOne({
      name: new RegExp(`^${req.params.name}$`, "i"),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Country not found" });
    }

    res.json({ message: "Country deleted successfully" });
  } catch (error) {
    console.error("Error deleting country:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `MongoDB: ${MONGODB_URI.includes("mongodb+srv") ? "Atlas" : "Local"}`
  );
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing server...");
  await mongoose.connection.close();
  process.exit(0);
});
