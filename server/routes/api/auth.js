const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const passport = require('passport');

const auth = require('../../middleware/auth');

// Bring in Models & Helpers
const User = require('../../models/user');
const mailchimp = require('../../services/mailchimp');
const mailgun = require('../../services/mailgun');
const keys = require('../../config/keys');
const { EMAIL_PROVIDER, JWT_COOKIE } = require('../../constants');

const { secret, tokenLife } = keys.jwt;

// Error Handling Middleware
const handleErrors = (res, status, message) => {
  res.status(status).json({ error: message });
};

// Input Validation
const validateUserInput = (res, { email, password, firstName, lastName, isSubscribed }) => {
  if (!email) {
    handleErrors(res, 400, 'You must enter an email address.');
  }

  if (!password) {
    handleErrors(res, 400, 'You must enter a password.');
  }

  if (!firstName || !lastName) {
    handleErrors(res, 400, 'You must enter your full name.');
  }

  if (isSubscribed && typeof isSubscribed !== 'boolean') {
    handleErrors(res, 400, 'Invalid subscription preference.');
  }
};

// Authentication Route Helper
const authenticateUser = async (email, password) => {
  const user = await User.findOne({ email });

  if (!user) {
    handleErrors(res, 400, 'No user found for this email address.');
  }

  if (user && user.provider !== EMAIL_PROVIDER.Email) {
    handleErrors(res, 400, `That email address is already in use using ${user.provider} provider.`);
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    handleErrors(res, 400, 'Password Incorrect');
  }

  return user;
};

// Login Route
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    validateUserInput(res, { email, password });

    const user = await authenticateUser(email, password);

    const payload = { id: user.id };
    const token = jwt.sign(payload, secret, { expiresIn: tokenLife });

    if (!token) {
      throw new Error();
    }

    res.status(200).json({
      success: true,
      token: `Bearer ${token}`,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    handleErrors(res, 400, 'Your request could not be processed. Please try again.');
  }
});

// Registration Route
router.post('/register', async (req, res) => {
  try {
    const { email, firstName, lastName, password, isSubscribed } = req.body;
    validateUserInput(res, { email, password, firstName, lastName, isSubscribed });

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      handleErrors(res, 400, 'That email address is already in use.');
    }

    let subscribed = false;
    if (isSubscribed) {
      const result = await mailchimp.subscribeToNewsletter(email);

      if (result.status === 'subscribed') {
        subscribed = true;
      }
    }

    const user = new User({
      email,
      password,
      firstName,
      lastName
    });

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(user.password, salt);

    user.password = hash;
    const registeredUser = await user.save();

    const payload = {
      id: registeredUser.id
    };

    await mailgun.sendEmail(
      registeredUser.email,
      'signup',
      null,
      registeredUser
    );

    const token = jwt.sign(payload, secret, { expiresIn: tokenLife });

    res.status(200).json({
      success: true,
      subscribed,
      token: `Bearer ${token}`,
      user: {
        id: registeredUser.id,
        firstName: registeredUser.firstName,
        lastName: registeredUser.lastName,
        email: registeredUser.email,
        role: registeredUser.role
      }
    });
  } catch (error) {
    handleErrors(res, 400, 'Your request could not be processed. Please try again.');
  }
});

// Forgot Password Route
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    validateUserInput(res, { email });

    const existingUser = await User.findOne({ email });

    if (!existingUser) {
      handleErrors(res, 400, 'No user found for this email address.');
    }

    const buffer = crypto.randomBytes(48);
    const resetToken = buffer.toString('hex');

    existingUser.resetPasswordToken = resetToken;
    existingUser.resetPasswordExpires = Date.now() + 3600000;

    existingUser.save();

    await mailgun.sendEmail(
      existingUser.email,
      'reset',
      req.headers.host,
      resetToken
    );

    res.status(200).json({
      success: true,
      message: 'Please check your email for the link to reset your password.'
    });
  } catch (error) {
    handleErrors(res, 400, 'Your request could not be processed. Please try again.');
  }
});

// Reset Password Route
router.post('/reset/:token', async (req, res) => {
  try {
    const { password } = req.body;
    validateUserInput(res, { password });

    const resetUser = await User.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!resetUser) {
      handleErrors(res, 400, 'Your token has expired. Please attempt to reset your password again.');
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    resetUser.password = hash;
    resetUser.resetPasswordToken = undefined;
    resetUser.resetPasswordExpires = undefined;

    resetUser.save();

    await mailgun.sendEmail(resetUser.email, 'reset-confirmation');

    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please login with your new password.'
    });
  } catch (error) {
    handleErrors(res, 400, 'Your request could not be processed. Please try again.');
  }
});

// Update Password Route
router.post('/reset', auth, async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;
    const email = req.user.email;

    validateUserInput(res, { password });

    const existingUser = await User.findOne({ email });
    if (!existingUser) {
      handleErrors(res, 400, 'That email address is already in use.');
    }

    const isMatch = await bcrypt.compare(password, existingUser.password);

    if (!isMatch) {
      handleErrors(res, 400, 'Please enter your correct old password.');
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(confirmPassword, salt);
    existingUser.password = hash;
    existingUser.save();

    await mailgun.sendEmail(existingUser.email, 'reset-confirmation');

    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please login with your new password.'
    });
  } catch (error) {
    handleErrors(res, 400, 'Your request could not be processed. Please try again.');
  }
});

// Google Authentication Route
router.get('/google', passport.authenticate('google', { session: false, scope: ['profile', 'email'], accessType: 'offline', approvalPrompt: 'force' }));

// Google Authentication Callback Route
router.get('/google/callback', passport.authenticate('google', { failureRedirect: `${keys.app.clientURL}/login`, session: false }), (req, res) => {
  const payload = { id: req.user.id };
  const token = jwt.sign(payload, secret, { expiresIn: tokenLife });
  const jwtToken = `Bearer ${token}`;
  res.redirect(`${keys.app.clientURL}/auth/success?token=${jwtToken}`);
});

// Facebook Authentication Route
router.get('/facebook', passport.authenticate('facebook', { session: false, scope: ['public_profile', 'email'] }));

// Facebook Authentication Callback Route
router.get('/facebook/callback', passport.authenticate('facebook', { failureRedirect: `${keys.app.clientURL}/login`, session: false }), (req, res) => {
  const payload = { id: req.user.id };
  const token = jwt.sign(payload, secret, { expiresIn: tokenLife });
  const jwtToken = `Bearer ${token}`;
  res.redirect(`${keys.app.clientURL}/auth/success?token=${jwtToken}`);
});

module.exports = router;
