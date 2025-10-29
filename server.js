const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const Jimp = require("jimp");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// MongoDB Connection
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/countries_db";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Country Schema
const countrySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  capital: String,
  region: String,
  population: { type: Number, required: true },
  currency_code: String,
  exchange_rate: Number,
  estimated_gdp: Number,
  flag_url: String,
  last_refreshed_at: { type: Date, default: Date.now },
});

// Add indexes for better query performance
countrySchema.index({ region: 1 });
countrySchema.index({ currency_code: 1 });
countrySchema.index({ estimated_gdp: -1 });

const Country = mongoose.model("Country", countrySchema);

// Metadata Schema
const metadataSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  last_refreshed_at: Date,
  total_countries: { type: Number, default: 0 },
});

const Metadata = mongoose.model("Metadata", metadataSchema);

// Generate summary image using Jimp
async function generateSummaryImage(totalCountries, topCountries, timestamp) {
  try {
    const width = 800;
    const height = 600;

    const image = new Jimp(width, height, "#1a1a2e");

    const fontLarge = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const fontMedium = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_14_WHITE);

    // Title
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

    // Total countries
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

    // Top 5 header
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

    // Top countries list
    let yPos = 220;
    for (let i = 0; i < topCountries.length && i < 5; i++) {
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

    // Timestamp
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

    // Save image
    const cacheDir = path.join(__dirname, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await image.writeAsync(path.join(cacheDir, "summary.png"));

    console.log("✅ Summary image generated successfully");
  } catch (error) {
    console.error("Failed to generate image:", error.message);
  }
}

// POST /countries/refresh
app.post("/countries/refresh", async (req, res) => {
  try {
    // Fetch countries data
    let countriesData;
    try {
      const countriesResponse = await axios.get(
        "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies",
        { timeout: 10000 }
      );
      countriesData = countriesResponse.data;
    } catch (error) {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from restcountries.com",
      });
    }

    // Fetch exchange rates
    let exchangeRates;
    try {
      const ratesResponse = await axios.get(
        "https://open.er-api.com/v6/latest/USD",
        { timeout: 10000 }
      );
      exchangeRates = ratesResponse.data.rates;
    } catch (error) {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from open.er-api.com",
      });
    }

    // Process each country
    const bulkOps = [];

    for (const country of countriesData) {
      const name = country.name;
      const capital = country.capital || null;
      const region = country.region || null;
      const population = country.population || 0;
      const flagUrl = country.flag || null;

      let currencyCode = null;
      let exchangeRate = null;
      let estimatedGdp = null;

      // Handle currencies
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

      // Prepare bulk operation (upsert)
      bulkOps.push({
        updateOne: {
          filter: { name: name },
          update: {
            $set: {
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

    // Execute bulk operations
    if (bulkOps.length > 0) {
      await Country.bulkWrite(bulkOps);
    }

    // Update metadata
    const totalCountries = await Country.countDocuments();
    const now = new Date();

    await Metadata.findOneAndUpdate(
      { _id: "global" },
      {
        last_refreshed_at: now,
        total_countries: totalCountries,
      },
      { upsert: true, new: true }
    );

    // Get top countries for image
    const topCountries = await Country.find({ estimated_gdp: { $ne: null } })
      .sort({ estimated_gdp: -1 })
      .limit(5)
      .lean();

    // Generate summary image
    try {
      await generateSummaryImage(
        totalCountries,
        topCountries,
        now.toISOString()
      );
    } catch (imgError) {
      console.error("Failed to generate image:", imgError.message);
    }

    res.json({
      message: "Countries data refreshed successfully",
      total_countries: totalCountries,
      last_refreshed_at: now,
    });
  } catch (error) {
    console.error("Error refreshing countries:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;

    // Build query
    const query = {};

    if (region) {
      query.region = new RegExp(`^${region}$`, "i");
    }

    if (currency) {
      query.currency_code = currency.toUpperCase();
    }

    // Build sort
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

    const countries = await Country.find(query).sort(sortOption).lean();

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
    }).lean();

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

// GET /status
app.get("/status", async (req, res) => {
  try {
    let metadata = await Metadata.findById("global");

    if (!metadata) {
      metadata = {
        total_countries: await Country.countDocuments(),
        last_refreshed_at: null,
      };
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

// GET /countries/image
app.get("/countries/image", async (req, res) => {
  try {
    const imagePath = path.join(__dirname, "cache", "summary.png");
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch (error) {
    res.status(404).json({ error: "Summary image not found" });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Country Currency & Exchange API", status: "running" });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
