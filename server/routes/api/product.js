const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');

const Product = require('../../models/product');
const Brand = require('../../models/brand');
const Category = require('../../models/category');
const authMiddleware = require('../../middleware/auth');
const roleMiddleware = require('../../middleware/role');
const { s3Upload } = require('../../utils/storage');
const {
  getStoreProductsQuery,
  getStoreProductsWishListQuery
} = require('../../utils/queries');
const { ROLES } = require('../../constants');

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Common error response function
const sendErrorResponse = (res, message) => {
  res.status(400).json({ error: message });
};

// Helper function to check if a brand is active
const isBrandActive = brand => brand && brand.isActive;

// Fetch product by slug
router.get('/item/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const productDoc = await Product.findOne({ slug, isActive: true }).populate({
      path: 'brand',
      select: 'name isActive slug'
    });

    if (!productDoc || !isBrandActive(productDoc.brand)) {
      return sendErrorResponse(res, 'No product found.');
    }

    res.status(200).json({ product: productDoc });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Fetch products by name search
router.get('/list/search/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const productDoc = await Product.find(
      { name: { $regex: new RegExp(name), $options: 'is' }, isActive: true },
      { name: 1, slug: 1, imageUrl: 1, price: 1, _id: 0 }
    );

    if (!productDoc || productDoc.length === 0) {
      return sendErrorResponse(res, 'No product found.');
    }

    res.status(200).json({ products: productDoc });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Fetch store products by advanced filters
router.get('/list', async (req, res) => {
  try {
    let {
      sortOrder,
      rating,
      max,
      min,
      category,
      page = 1,
      limit = 10
    } = req.query;
    sortOrder = JSON.parse(sortOrder);

    const categoryFilter = category ? { category } : {};
    const basicQuery = getStoreProductsQuery(min, max, rating);

    const userDoc = await checkAuth(req);
    const categoryDoc = await Category.findOne(
      { slug: categoryFilter.category, isActive: true },
      'products -_id'
    );

    if (categoryDoc && categoryFilter !== category) {
      basicQuery.push({
        $match: {
          isActive: true,
          _id: {
            $in: Array.from(categoryDoc.products)
          }
        }
      });
    }

    let products = null;
    const productsCount = await Product.aggregate(basicQuery);
    const count = productsCount.length;
    const size = count > limit ? page - 1 : 0;
    const currentPage = count > limit ? Number(page) : 1;

    // paginate query
    const paginateQuery = [
      { $sort: sortOrder },
      { $skip: size * limit },
      { $limit: limit * 1 }
    ];

    if (userDoc) {
      const wishListQuery = getStoreProductsWishListQuery(userDoc.id).concat(
        basicQuery
      );
      products = await Product.aggregate(wishListQuery.concat(paginateQuery));
    } else {
      products = await Product.aggregate(basicQuery.concat(paginateQuery));
    }

    if (!products || products.length === 0) {
      return sendErrorResponse(res, 'No products found.');
    }

    res.status(200).json({ products, totalPages: Math.ceil(count / limit), currentPage, count });
  } catch (error) {
    console.log('error', error);
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Fetch store products by brand
router.get('/list/brand/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;

    const brand = await Brand.findOne({ slug, isActive: true });

    if (!brand) {
      return sendErrorResponse(res, `Cannot find brand with the slug: ${slug}.`);
    }

    const userDoc = await checkAuth(req);

    if (userDoc) {
      const products = await Product.aggregate([
        {
          $match: {
            isActive: true,
            brand: brand._id
          }
        },
        {
          $lookup: {
            from: 'wishlists',
            let: { product: '$_id' },
            pipeline: [
              {
                $match: {
                  $and: [
                    { $expr: { $eq: ['$$product', '$product'] } },
                    { user: new mongoose.Types.ObjectId(userDoc.id) }
                  ]
                }
              }
            ],
            as: 'isLiked'
          }
        },
        {
          $lookup: {
            from: 'brands',
            localField: 'brand',
            foreignField: '_id',
            as: 'brands'
          }
        },
        {
          $addFields: {
            isLiked: { $arrayElemAt: ['$isLiked.isLiked', 0] }
          }
        },
        {
          $unwind: '$brands'
        },
        {
          $addFields: {
            'brand.name': '$brands.name',
            'brand._id': '$brands._id',
            'brand.isActive': '$brands.isActive'
          }
        },
        { $project: { brands: 0 } }
      ]);

      res.status(200).json({
        products: products.reverse().slice(0, 8),
        page: 1,
        pages: products.length > 0 ? Math.ceil(products.length / 8) : 0,
        totalProducts: products.length
      });
    } else {
      const products = await Product.find({
        brand: brand._id,
        isActive: true
      }).populate('brand', 'name');

      res.status(200).json({
        products: products.reverse().slice(0, 8),
        page: 1,
        pages: products.length > 0 ? Math.ceil(products.length / 8) : 0,
        totalProducts: products.length
      });
    }
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

router.get('/list/select', authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({}, 'name');

    res.status(200).json({
      products
    });
  } catch (error) {
    sendErrorResponse(res, 'Your request could not be processed. Please try again.');
  }
});

// Add product
router.post(
  '/add',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  upload.single('image'),
  async (req, res) => {
    try {
      const sku = req.body.sku;
      const name = req.body.name;
      const description = req.body.description;
      const quantity = req.body.quantity;
      const price = req.body.price;
      const taxable = req.body.taxable;
      const isActive = req.body.isActive;
      const brand = req.body.brand;
      const image = req.file;

      if (!sku || !description || !name || !quantity || !price) {
        return sendErrorResponse(res, 'Invalid input. Ensure all required fields are provided.');
      }

      const foundProduct = await Product.findOne({ sku });

      if (foundProduct) {
        return sendErrorResponse(res, 'This sku is already in use.');
      }

      const { imageUrl, imageKey } = await s3Upload(image);

      const product = new Product({
        sku,
        name,
        description,
        quantity,
        price,
        taxable,
        isActive,
        brand,
        imageUrl,
        imageKey
      });

      const savedProduct = await product.save();

      res.status(200).json({
        success: true,
        message: 'Product has been added successfully!',
        product: savedProduct
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

// Fetch products
router.get(
  '/',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  async (req, res) => {
    try {
      let products = [];

      if (req.user.merchant) {
        const brands = await Brand.find({
          merchant: req.user.merchant
        }).populate('merchant', '_id');

        const brandId = brands[0]?.['_id'];

        products = await Product.find({})
          .populate({
            path: 'brand',
            populate: {
              path: 'merchant',
              model: 'Merchant'
            }
          })
          .where('brand', brandId);
      } else {
        products = await Product.find({}).populate({
          path: 'brand',
          populate: {
            path: 'merchant',
            model: 'Merchant'
          }
        });
      }

      res.status(200).json({
        products
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

// Fetch product
router.get(
  '/:id',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  async (req, res) => {
    try {
      const productId = req.params.id;

      let productDoc = null;

      if (req.user.merchant) {
        const brands = await Brand.find({
          merchant: req.user.merchant
        }).populate('merchant', '_id');

        const brandId = brands[0]['_id'];

        productDoc = await Product.findOne({ _id: productId })
          .populate({
            path: 'brand',
            select: 'name'
          })
          .where('brand', brandId);
      } else {
        productDoc = await Product.findOne({ _id: productId }).populate({
          path: 'brand',
          select: 'name'
        });
      }

      if (!productDoc) {
        return sendErrorResponse(res, 'No product found.');
      }

      res.status(200).json({
        product: productDoc
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

// Update product
router.put(
  '/:id',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  async (req, res) => {
    try {
      const productId = req.params.id;
      const update = req.body.product;
      const query = { _id: productId };
      const { sku, slug } = req.body.product;

      const foundProduct = await Product.findOne({
        $or: [{ slug }, { sku }]
      });

      if (foundProduct && foundProduct._id != productId) {
        return sendErrorResponse(res, 'Sku or slug is already in use.');
      }

      await Product.findOneAndUpdate(query, update, {
        new: true
      });

      res.status(200).json({
        success: true,
        message: 'Product has been updated successfully!'
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

// Update product's active status
router.put(
  '/:id/active',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  async (req, res) => {
    try {
      const productId = req.params.id;
      const update = req.body.product;
      const query = { _id: productId };

      await Product.findOneAndUpdate(query, update, {
        new: true
      });

      res.status(200).json({
        success: true,
        message: 'Product has been updated successfully!'
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

// Delete product
router.delete(
  '/delete/:id',
  authMiddleware,
  roleMiddleware.check(ROLES.Admin, ROLES.Merchant),
  async (req, res) => {
    try {
      const product = await Product.deleteOne({ _id: req.params.id });

      res.status(200).json({
        success: true,
        message: 'Product has been deleted successfully!',
        product
      });
    } catch (error) {
      sendErrorResponse(res, 'Your request could not be processed. Please try again.');
    }
  }
);

module.exports = router;
