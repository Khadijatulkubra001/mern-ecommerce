const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { MERCHANT_STATUS, ROLES } = require('../../constants');
const Merchant = require('../../models/merchant');
const User = require('../../models/user');
const Brand = require('../../models/brand');
const auth = require('../../middleware/auth');
const role = require('../../middleware/role');
const mailgun = require('../../services/mailgun');

// Common error response function
const sendErrorResponse = (res, message) => {
  res.status(400).json({ error: message });
};

// Function to deactivate brand
const deactivateBrand = async (merchantId) => {
  try {
    const merchantDoc = await Merchant.findOne({ _id: merchantId }).populate('brand', '_id');
    if (!merchantDoc || !merchantDoc.brand) return;

    const brandId = merchantDoc.brand._id;
    const query = { _id: brandId };
    const update = { isActive: false };

    return await Brand.findOneAndUpdate(query, update, { new: true });
  } catch (error) {
    throw error;
  }
};

// Function to create merchant brand
const createMerchantBrand = async ({ _id, brandName, business }) => {
  try {
    const newBrand = new Brand({
      name: brandName,
      description: business,
      merchant: _id,
      isActive: false
    });

    const brandDoc = await newBrand.save();

    const update = { brand: brandDoc._id };
    await Merchant.findOneAndUpdate({ _id }, update);
  } catch (error) {
    throw error;
  }
};

// Function to create merchant user
const createMerchantUser = async (email, name, merchant, host) => {
  try {
    const firstName = name;
    const lastName = '';

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      const query = { _id: existingUser._id };
      const update = { merchant, role: ROLES.Merchant };

      const merchantDoc = await Merchant.findOne({ email });
      await createMerchantBrand(merchantDoc);

      await mailgun.sendEmail(email, 'merchant-welcome', null, name);

      return await User.findOneAndUpdate(query, update, { new: true });
    } else {
      const buffer = await crypto.randomBytes(48);
      const resetToken = buffer.toString('hex');
      const resetPasswordToken = resetToken;

      const user = new User({
        email,
        firstName,
        lastName,
        resetPasswordToken,
        merchant,
        role: ROLES.Merchant
      });

      await mailgun.sendEmail(email, 'merchant-signup', host, {
        resetToken,
        email
      });

      return await user.save();
    }
  } catch (error) {
    throw error;
  }
};

// Add merchant API
router.post('/add', async (req, res) => {
  try {
    const { name, business, phoneNumber, email, brandName } = req.body;

    // Validation checks
    if (!name || !email || !business || !phoneNumber) {
      return sendErrorResponse(res, 'Invalid input. Ensure all required fields are provided.');
    }

    const existingMerchant = await Merchant.findOne({ email });

    if (existingMerchant) {
      return sendErrorResponse(res, 'That email address is already in use.');
    }

    // Save merchant
    const merchant = new Merchant({ name, email, business, phoneNumber, brandName });
    const merchantDoc = await merchant.save();

    // Send email notification
    await mailgun.sendEmail(email, 'merchant-application');

    res.status(200).json({
      success: true,
      message: `We received your request! We will reach you on your phone number ${phoneNumber}!`,
      merchant: merchantDoc
    });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Search merchants API
router.get('/search', auth, role.check(ROLES.Admin), async (req, res) => {
  try {
    const { search } = req.query;
    const regex = new RegExp(search, 'i');

    const merchants = await Merchant.find({
      $or: [
        { phoneNumber: { $regex: regex } },
        { email: { $regex: regex } },
        { name: { $regex: regex } },
        { brandName: { $regex: regex } },
        { status: { $regex: regex } }
      ]
    }).populate('brand', 'name');

    res.status(200).json({ merchants });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Fetch all merchants API
router.get('/', auth, role.check(ROLES.Admin), async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const merchants = await Merchant.find()
      .populate('brand')
      .sort('-created')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const count = await Merchant.countDocuments();

    res.status(200).json({
      merchants,
      totalPages: Math.ceil(count / limit),
      currentPage: Number(page),
      count
    });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Disable merchant account
router.put('/:id/active', auth, async (req, res) => {
  try {
    const merchantId = req.params.id;
    const update = req.body.merchant;
    const query = { _id: merchantId };

    const merchantDoc = await Merchant.findOneAndUpdate(query, update, { new: true });

    if (!update.isActive) {
      await deactivateBrand(merchantId);
      await mailgun.sendEmail(merchantDoc.email, 'merchant-deactivate-account');
    }

    res.status(200).json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Approve merchant
router.put('/approve/:id', auth, async (req, res) => {
  try {
    const merchantId = req.params.id;
    const query = { _id: merchantId };
    const update = { status: MERCHANT_STATUS.Approved, isActive: true };

    const merchantDoc = await Merchant.findOneAndUpdate(query, update, { new: true });

    await createMerchantUser(
      merchantDoc.email,
      merchantDoc.name,
      merchantId,
      req.headers.host
    );

    res.status(200).json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Reject merchant
router.put('/reject/:id', auth, async (req, res) => {
  try {
    const merchantId = req.params.id;
    const query = { _id: merchantId };
    const update = { status: MERCHANT_STATUS.Rejected };

    await Merchant.findOneAndUpdate(query, update, { new: true });

    res.status(200).json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Merchant signup API
router.post('/signup/:token', async (req, res) => {
  try {
    const { email, firstName, lastName, password } = req.body;

    // Validation checks
    if (!email || !firstName || !lastName || !password) {
      return sendErrorResponse(res, 'Invalid input. Ensure all required fields are provided.');
    }

    const userDoc = await User.findOne({ email, resetPasswordToken: req.params.token });
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const query = { _id: userDoc._id };
    const update = { email, firstName, lastName, password: hash, resetPasswordToken: undefined };

    await User.findOneAndUpdate(query, update, { new: true });

    const merchantDoc = await Merchant.findOne({ email });
    await createMerchantBrand(merchantDoc);

    res.status(200).json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Delete merchant API
router.delete('/delete/:id', auth, role.check(ROLES.Admin), async (req, res) => {
  try {
    const merchantId = req.params.id;
    await deactivateBrand(merchantId);
    const merchant = await Merchant.deleteOne({ _id: merchantId });

    res.status(200).json({
      success: true,
      message: 'Merchant has been deleted successfully!',
      merchant
    });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

module.exports = router;
