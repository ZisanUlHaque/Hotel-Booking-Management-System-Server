// server.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRETE);

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");


const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

//verify token
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ifwcykr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("travelio_user");
    const bookingCollection = db.collection("bookings");
    const paymentCollection = db.collection("payments"); // ✅ NEW
    const usersCollection = db.collection("users"); // ✅ NEW

    /* -------------------------- DASHBOARD STATS -------------------------- */

    app.get("/dashboard-stats", async (req, res) => {
      try {
        // overall counts
        const totalBookings = await bookingCollection.countDocuments();
        const confirmed = await bookingCollection.countDocuments({
          status: "confirmed",
        });
        const pending = await bookingCollection.countDocuments({
          status: "pending",
        });
        const cancelled = await bookingCollection.countDocuments({
          status: "cancelled",
        });
        const totalUsers = await usersCollection.countDocuments();

        // revenue (cents)
        const revenueAgg = await paymentCollection
          .aggregate([
            {
              $group: {
                _id: null,
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray();
        const totalRevenue = revenueAgg[0]?.total || 0;

        // recent bookings
        const recentBookings = await bookingCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        // simple booking chart data: last 6 months by createdAt
        const allBookings = await bookingCollection
          .find({})
          .project({ createdAt: 1 })
          .toArray();

        const monthMap = {}; // { '2025-0': count, ...}
        allBookings.forEach((b) => {
          const d = new Date(b.createdAt);
          if (isNaN(d)) return;
          const key = `${d.getFullYear()}-${d.getMonth()}`;
          monthMap[key] = (monthMap[key] || 0) + 1;
        });

        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];

        const bookingChartData = Object.entries(monthMap)
          .map(([key, count]) => {
            const [year, month] = key.split("-").map(Number);
            return {
              name: `${monthNames[month]} ${String(year).slice(-2)}`,
              bookings: count,
              sortKey: new Date(year, month, 1).getTime(),
            };
          })
          .sort((a, b) => a.sortKey - b.sortKey)
          .slice(-6) // last 6 months
          .map(({ sortKey, ...rest }) => rest);

        res.send({
          totalBookings,
          confirmed,
          pending,
          cancelled,
          totalRevenue, // cents
          totalUsers,
          recentBookings,
          bookingChartData,
        });
      } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).send({ message: "Failed to get dashboard stats" });
      }
    });
    // ✅ GET all bookings or filter by email
    app.get("/bookings", async (req, res) => {
      try {
        const query = {};
        const { email, status, userId } = req.query;

        if (email) {
          query.userEmail = email;
        }
        if (status) {
          query.status = status;
        }
        if (userId) {
          query.userId = userId;
        }

        const cursor = bookingCollection.find(query).sort({ createdAt: -1 });
        const result = await cursor.toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching bookings:", error);
        res.status(500).send({
          message: "Failed to fetch bookings",
          error: error.message,
        });
      }
    });

    // ✅ GET single booking by ID
    app.get("/bookings/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await bookingCollection.findOne(query);

        if (!result) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Error fetching booking:", error);
        res.status(500).send({
          message: "Failed to fetch booking",
          error: error.message,
        });
      }
    });

    // ✅ POST create new booking
    app.post("/bookings", async (req, res) => {
      try {
        const booking = req.body;

        if (!booking.tourId || !booking.userEmail || !booking.travelDate) {
          return res.status(400).send({
            message:
              "Missing required fields: tourId, userEmail, and travelDate are required",
          });
        }

        booking.createdAt = new Date();
        booking.status = booking.status || "pending";
        booking.paymentStatus = booking.paymentStatus || "unpaid";

        const result = await bookingCollection.insertOne(booking);
        res.send(result);
      } catch (error) {
        console.error("Error creating booking:", error);
        res.status(500).send({
          message: "Failed to create booking",
          error: error.message,
        });
      }
    });

    // ✅ PATCH update booking
    app.patch("/bookings/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updateData = req.body;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            ...updateData,
            updatedAt: new Date().toISOString(),
          },
        };

        const result = await bookingCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Error updating booking:", error);
        res.status(500).send({
          message: "Failed to update booking",
          error: error.message,
        });
      }
    });

    // ✅ DELETE booking
    app.delete("/bookings/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await bookingCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Booking not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Error deleting booking:", error);
        res.status(500).send({
          message: "Failed to delete booking",
          error: error.message,
        });
      }
    });

    /* -------------------- STRIPE CHECKOUT (PAYMENT) -------------------- */

    // ✅ Create checkout session from existing booking
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { bookingId } = req.body;
        if (!bookingId) {
          return res.status(400).send({ message: "bookingId is required" });
        }

        const booking = await bookingCollection.findOne({
          _id: new ObjectId(bookingId),
        });

        if (!booking) {
          return res.status(404).send({ message: "Booking not found" });
        }

        const amount =
          Math.round(
            Number(
              booking.finalPrice ||
                booking.originalTotal ||
                booking.pricePerPerson *
                  (booking.guests || booking.numberOfGuests || 1)
            ) * 100
          ) || 0;

        if (!amount) {
          return res.status(400).send({ message: "Invalid booking amount" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          customer_email: booking.userEmail || undefined,
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: amount,
                product_data: {
                  name: booking.tourTitle || "Tour Booking",
                },
              },
              quantity: 1,
            },
          ],
          metadata: {
            bookingId: booking._id.toString(),
            tourId: booking.tourId?.toString() || "",
            userEmail: booking.userEmail || "",
          },
          success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/my-booking`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe checkout error:", error);
        res.status(500).send({
          message: "Failed to create checkout session",
          error: error.message,
        });
      }
    });

    // ✅ Confirm payment & update booking + save payment
    app.get("/booking-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.status(400).send({ message: "Missing session_id" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const transactionId = session.payment_intent;
        const amount = session.amount_total; // cents
        const currency = session.currency;
        const meta = session.metadata || {};

        // Check existing payment to avoid duplicate
        const existing = await paymentCollection.findOne({
          transactionId,
        });
        if (existing) {
          return res.send({
            message: "already exists",
            transactionId,
            payment: existing,
          });
        }

        if (session.payment_status === "paid") {
          // Save payment info
          const paymentDoc = {
            bookingId: meta.bookingId || "",
            tourId: meta.tourId || "",
            userEmail: meta.userEmail || session.customer_email,
            amount,
            currency,
            transactionId,
            paymentStatus: session.payment_status,
            createdAt: new Date(),
          };

          const payResult = await paymentCollection.insertOne(paymentDoc);

          // Update booking
          if (meta.bookingId) {
            await bookingCollection.updateOne(
              { _id: new ObjectId(meta.bookingId) },
              {
                $set: {
                  paymentStatus: "paid",
                  status: "confirmed",
                  transactionId,
                  updatedAt: new Date().toISOString(),
                },
              }
            );
          }

          const booking = meta.bookingId
            ? await bookingCollection.findOne({
                _id: new ObjectId(meta.bookingId),
              })
            : null;

          return res.send({
            success: true,
            transactionId,
            paymentId: payResult.insertedId,
            bookingId: meta.bookingId,
            booking,
          });
        }

        res.send({
          success: false,
          message: "Payment not completed",
        });
      } catch (error) {
        console.error("Booking success error:", error);
        res.status(500).send({
          message: "Failed to confirm booking",
          error: error.message,
        });
      }
    });

    /* -------------------------- USERS CRUD -------------------------- */

    // Create / Upsert user (Registration/Login)
    app.post("/users", async (req, res) => {
      try {
        const user = req.body; // {name, email, avatar, country, travelStyle, ...}

        if (!user.email) {
          return res.status(400).send({ message: "Email is required" });
        }

        // default role: user
        user.role = user.role || "user";
        user.updatedAt = new Date();

        const result = await usersCollection.updateOne(
          { email: user.email },
          { $set: user },
          { upsert: true }
        );

        res.send(result);
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).send({
          message: "Failed to save user",
          error: error.message,
        });
      }
    });

    // Get all users (for admin)
    app.get("/users",verifyFBToken, async (req, res) => {

      // console.log(req.headers);
      try {
        const { role } = req.query;
        const query = {};
        if (role) query.role = role;

        const users = await usersCollection
          .find(query)
          .sort({ updatedAt: -1 })
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("Get users error:", error);
        res.status(500).send({ message: "Failed to get users" });
      }
    });

    // Get user profile by email (for Profile page / useAuth)
    app.get("/users/profile/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        console.error("Get user profile error:", error);
        res.status(500).send({ message: "Failed to get user profile" });
      }
    });

    // Update user profile (name, phone, country, travelStyle, etc)
    app.patch("/users/profile/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const updated = req.body;

        // নিরাপদ থাকার জন্য কিছু field override হতে দেব না
        delete updated.email;
        delete updated.role;

        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              ...updated,
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        console.error("Update user profile error:", error);
        res.status(500).send({ message: "Failed to update user profile" });
      }
    });

    // Get user role by email (useAdmin hook এর জন্য)
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        res.send({ role: user?.role || "user" });
      } catch (error) {
        console.error("Get user role error:", error);
        res.status(500).send({ message: "Failed to get user role" });
      }
    });

    // Update user role (admin panel → Make Admin)
    app.patch("/users/:id/role", async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body;

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              role,
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        console.error("Update user role error:", error);
        res.status(500).send({ message: "Failed to update role" });
      }
    });

    // Delete user (admin)
    app.delete("/users/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(result);
      } catch (error) {
        console.error("Delete user error:", error);
        res.status(500).send({ message: "Failed to delete user" });
      }
    });
    // test ping
    // await client.db("admin").command({ ping: 1 });
    // console.log("✅ Connected to MongoDB, APIs ready");
  } catch (error) {
    // console.error("Mongo error:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Happy Travelinggggg!!!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
