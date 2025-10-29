const express = require("express");
const mysql = require("mysql2/promise");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const Jimp = require("jimp");
require("dotenv").config();

const app = express();
app.use(express.json());

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "countries_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Initialize database
async function initDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS countries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        capital VARCHAR(255),
        region VARCHAR(255),
        population BIGINT NOT NULL,
        currency_code VARCHAR(10),
        exchange_rate DECIMAL(20, 6),
        estimated_gdp DECIMAL(30, 2),
        flag_url TEXT,
        last_refreshed_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_region (region),
        INDEX idx_currency (currency_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS refresh_metadata (
        id INT PRIMARY KEY DEFAULT 1,
        last_refreshed_at DATETIME,
        total_countries INT DEFAULT 0,
        CHECK (id = 1)
      )
    `);

    const [rows] = await connection.query(
      "SELECT COUNT(*) as count FROM refresh_metadata"
    );
    if (rows[0].count === 0) {
      await connection.query("INSERT INTO refresh_metadata (id) VALUES (1)");
    }
  } finally {
    connection.release();
  }
}

// Generate summary image using Jimp
async function generateSummaryImage(totalCountries, topCountries, timestamp) {
  try {
    const width = 800;
    const height = 600;

    // Create image with background color
    const image = new Jimp(width, height, "#1a1a2e");

    // Load fonts
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
  const connection = await pool.getConnection();
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

    await connection.beginTransaction();

    // Process each country
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
        // No currencies - set GDP to 0
        estimatedGdp = 0;
      }

      // Insert or update
      await connection.query(
        `
        INSERT INTO countries 
        (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          capital = VALUES(capital),
          region = VALUES(region),
          population = VALUES(population),
          currency_code = VALUES(currency_code),
          exchange_rate = VALUES(exchange_rate),
          estimated_gdp = VALUES(estimated_gdp),
          flag_url = VALUES(flag_url),
          last_refreshed_at = CURRENT_TIMESTAMP
      `,
        [
          name,
          capital,
          region,
          population,
          currencyCode,
          exchangeRate,
          estimatedGdp,
          flagUrl,
        ]
      );
    }

    // Update metadata
    const [countResult] = await connection.query(
      "SELECT COUNT(*) as total FROM countries"
    );
    const totalCountries = countResult[0].total;

    await connection.query(
      `
      UPDATE refresh_metadata 
      SET last_refreshed_at = CURRENT_TIMESTAMP, total_countries = ?
      WHERE id = 1
    `,
      [totalCountries]
    );

    await connection.commit();

    // Get metadata for response and image
    const [metadata] = await connection.query(
      "SELECT * FROM refresh_metadata WHERE id = 1"
    );
    const [topCountries] = await connection.query(`
      SELECT name, estimated_gdp 
      FROM countries 
      WHERE estimated_gdp IS NOT NULL
      ORDER BY estimated_gdp DESC 
      LIMIT 5
    `);

    // Generate summary image (optional)
    try {
      await generateSummaryImage(
        totalCountries,
        topCountries,
        metadata[0].last_refreshed_at.toISOString()
      );
    } catch (imgError) {
      console.error("Failed to generate image:", imgError.message);
      // Continue without image - not critical
    }

    res.json({
      message: "Countries data refreshed successfully",
      total_countries: totalCountries,
      last_refreshed_at: metadata[0].last_refreshed_at,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error refreshing countries:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

// GET /countries
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;

    let query = "SELECT * FROM countries WHERE 1=1";
    const params = [];

    if (region) {
      query += " AND LOWER(region) = LOWER(?)";
      params.push(region);
    }

    if (currency) {
      query += " AND currency_code = ?";
      params.push(currency.toUpperCase());
    }

    // Sorting
    if (sort === "gdp_desc") {
      query += " ORDER BY estimated_gdp DESC";
    } else if (sort === "gdp_asc") {
      query += " ORDER BY estimated_gdp ASC";
    } else if (sort === "population_desc") {
      query += " ORDER BY population DESC";
    } else if (sort === "population_asc") {
      query += " ORDER BY population ASC";
    } else {
      query += " ORDER BY name ASC";
    }

    const [countries] = await pool.query(query, params);
    res.json(countries);
  } catch (error) {
    console.error("Error fetching countries:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/:name
app.get("/countries/:name", async (req, res) => {
  try {
    const [countries] = await pool.query(
      "SELECT * FROM countries WHERE LOWER(name) = LOWER(?)",
      [req.params.name]
    );

    if (countries.length === 0) {
      return res.status(404).json({ error: "Country not found" });
    }

    res.json(countries[0]);
  } catch (error) {
    console.error("Error fetching country:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /countries/:name
app.delete("/countries/:name", async (req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM countries WHERE LOWER(name) = LOWER(?)",
      [req.params.name]
    );

    if (result.affectedRows === 0) {
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
    const [metadata] = await pool.query(
      "SELECT * FROM refresh_metadata WHERE id = 1"
    );

    res.json({
      total_countries: metadata[0].total_countries,
      last_refreshed_at: metadata[0].last_refreshed_at,
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

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
