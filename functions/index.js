const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");
const { APIContracts, Constants, APIControllers } = authorizenet;

admin.initializeApp();

// Add server-side pricing validation
const planPricing = {
    'essentials': {
        monthly: '99.00',
        annual: '990.00'
    },
    'premium': {
        monthly: '199.00',
        annual: '1990.00'
    }
};

// Helper function to get correct plan price
function getPlanPrice(planName, billingCycle = 'monthly') {
    const planType = planName.toLowerCase().includes('essentials') ? 'essentials' : 'premium';
    const cycle = billingCycle.toLowerCase() === 'annual' ? 'annual' : 'monthly';
    return planPricing[planType][cycle];
}

// Helper function to determine billing cycle
function determineBillingCycle(planName, planPrice = null) {
    // If price is provided, use it to determine cycle
    if (planPrice) {
        const price = parseFloat(planPrice);
        return price >= 990 ? 'annual' : 'monthly';
    }

    // Otherwise, check plan name for indicators
    if (planName.toLowerCase().includes('annual') || planName.toLowerCase().includes('year')) {
        return 'annual';
    }

    return 'monthly';
}

exports.createSubscription = functions.https.onRequest(async (req, res) => {
    try {
        functions.logger.info("--- New Request Received ---", req.body);

        if (!req.body || !req.body.email || !req.body.planPrice || !req.body.paymentDetails) {
            functions.logger.error("Request is missing required data.", req.body);
            return res.status(400).send({ error: 'Request is missing required data.' });
        }

        const { email, password, planName, planPrice, paymentDetails, name, isAdvisor } = req.body;
        
        // ADD DEBUGGING FOR PLAN PRICE
        functions.logger.info('Received signup data:', { 
            email, 
            planName, 
            planPrice: planPrice,
            planPriceType: typeof planPrice,
            parsedPlanPrice: parseFloat(planPrice)
        });
        
        const { cardNumber, expiryDate, cardCode } = paymentDetails;

        if (!cardNumber || !expiryDate || !cardCode) {
            functions.logger.error("Request is missing payment details.", paymentDetails);
            return res.status(400).send({ error: 'Request is missing payment details.' });
        }

        // SERVER-SIDE PRICE VALIDATION
        const billingCycle = determineBillingCycle(planName, planPrice);
        const expectedPrice = getPlanPrice(planName, billingCycle);
        const numericPlanPrice = parseFloat(expectedPrice);
        const receivedPrice = parseFloat(planPrice);

        functions.logger.info('Price validation:', {
            planName: planName,
            billingCycle: billingCycle,
            expectedPrice: expectedPrice,
            receivedPrice: receivedPrice,
            numericPlanPrice: numericPlanPrice,
            pricesMatch: receivedPrice === numericPlanPrice
        });

        // Validate that received price matches expected price
        if (receivedPrice !== numericPlanPrice) {
            functions.logger.error(`Price mismatch: received ${receivedPrice}, expected ${numericPlanPrice} for ${planName} ${billingCycle}`);
            return res.status(400).send({ 
                error: `Invalid plan price. Expected ${numericPlanPrice} for ${planName} ${billingCycle}.` 
            });
        }

        // Validate plan price is positive
        if (isNaN(numericPlanPrice) || numericPlanPrice <= 0) {
            functions.logger.error("Invalid plan price:", expectedPrice);
            return res.status(400).send({ error: 'Invalid plan price provided.' });
        }

        functions.logger.info('✅ Price validation passed:', {
            planName: planName,
            billingCycle: billingCycle,
            validatedPrice: numericPlanPrice
        });

        // Try Firebase secrets first, fallback to hardcoded (remove in production)
        const apiLoginId = functions.config().authorizenet?.api_login_id || "7V4Drk4V";
        const transactionKey = functions.config().authorizenet?.transaction_key || "45Rs7ua39ADf6cAd";
        const authNetEnvironment = Constants.endpoint.sandbox; // Default to sandbox

        functions.logger.info("Authorize.Net API Login ID:", apiLoginId ? "Loaded" : "Not loaded");
        functions.logger.info("Authorize.Net Transaction Key:", transactionKey ? "Loaded" : "Not loaded");
        functions.logger.info("Environment:", authNetEnvironment === Constants.endpoint.sandbox ? "SANDBOX" : "PRODUCTION");

        if (!apiLoginId || !transactionKey) {
            functions.logger.error("Authorize.Net credentials not found.");
            return res.status(500).send({ error: 'Server payment configuration error.' });
        }

        const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
        merchantAuthenticationType.setName(apiLoginId);
        merchantAuthenticationType.setTransactionKey(transactionKey);

        const paymentSchedule = new APIContracts.PaymentScheduleType();
        const interval = new APIContracts.PaymentScheduleType.Interval();
        
        // Set interval based on billing cycle
        if (billingCycle === 'annual') {
            interval.setLength(12);
            interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
        } else {
            interval.setLength(1);
            interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
        }
        
        paymentSchedule.setInterval(interval);
        paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
        paymentSchedule.setTotalOccurrences(9999);

        const creditCard = new APIContracts.CreditCardType();
        creditCard.setCardNumber(cardNumber);   

        if (typeof expiryDate !== 'string' || !expiryDate.includes('/')) {
            functions.logger.error(`Invalid expiry date format: ${expiryDate}. Use MM/YY.`);
            return res.status(400).send({ error: 'Invalid expiry date format. Use MM/YY.' });
        }
        const [month, year] = expiryDate.split('/');
        creditCard.setExpirationDate(`20${year}-${month}`);
        creditCard.setCardCode(cardCode);

        const payment = new APIContracts.PaymentType();
        payment.setCreditCard(creditCard);

        const arbSubscription = new APIContracts.ARBSubscriptionType();
        arbSubscription.setName(`${planName} - ${billingCycle}`);
        arbSubscription.setPaymentSchedule(paymentSchedule);
        
        // Use server-validated price
        functions.logger.info('Setting subscription amount:', {
            planName: planName,
            billingCycle: billingCycle,
            validatedPrice: numericPlanPrice,
            aboutToSet: numericPlanPrice
        });
        
        arbSubscription.setAmount(numericPlanPrice);
        arbSubscription.setPayment(payment);

        const customer = new APIContracts.CustomerType();
        customer.setEmail(email);
        arbSubscription.setCustomer(customer);

        const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
        createRequest.setMerchantAuthentication(merchantAuthenticationType);
        createRequest.setSubscription(arbSubscription);

        // ADD DEBUGGING FOR THE FULL REQUEST
        functions.logger.info('Full subscription request being sent:', {
            subscriptionName: `${planName} - ${billingCycle}`,
            subscriptionAmount: numericPlanPrice,
            customerEmail: email,
            billingCycle: billingCycle,
            paymentSchedule: {
                intervalLength: billingCycle === 'annual' ? 12 : 1,
                intervalUnit: 'MONTHS',
                totalOccurrences: 9999
            }
        });

        const ctrl = new APIControllers.ARBCreateSubscriptionController(createRequest.getJSON());
        ctrl.setEnvironment(authNetEnvironment);

        functions.logger.info('Attempting to execute Authorize.Net transaction...');

        ctrl.execute(async () => {
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            // ADD DEBUGGING FOR THE RESPONSE
            functions.logger.info('Authorize.Net API Response:', JSON.stringify(apiResponse, null, 2));

            if (response != null && response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                functions.logger.info(`SUCCESS: Authorize.Net subscription created: ${subscriptionId}`);
                
                // LOG THE SUBSCRIPTION DETAILS
                functions.logger.info('Subscription created with details:', {
                    subscriptionId: subscriptionId,
                    planName: planName,
                    billingCycle: billingCycle,
                    amount: numericPlanPrice,
                    email: email
                });

                try {
                    functions.logger.info(`Attempting to create user in Firebase Auth for: ${email}`);
                    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
                    functions.logger.info(`SUCCESS: User created in Firebase Auth: ${userRecord.uid}`);

                    // Calculate subscription end date based on billing cycle
                    const subscriptionEndDate = new Date();
                    if (billingCycle === 'annual') {
                        subscriptionEndDate.setFullYear(subscriptionEndDate.getFullYear() + 1);
                    } else {
                        subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
                    }

                    await admin.firestore().collection("users").doc(userRecord.uid).set({
                        name: name,
                        email: email,
                        plan: planName,
                        billingCycle: billingCycle,
                        planPrice: numericPlanPrice,
                        authNetSubscriptionId: subscriptionId,
                        subscriptionStatus: "active",
                        subscriptionStartDate: admin.firestore.FieldValue.serverTimestamp(),
                        subscriptionEndDate: subscriptionEndDate,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isAdvisor: isAdvisor || false,
                        isAdmin: (email === "admin@simplifinance.com")
                    });
                    functions.logger.info(`SUCCESS: User data saved to Firestore for UID: ${userRecord.uid}`);
                    res.status(200).send({ 
                        status: 'success', 
                        userId: userRecord.uid,
                        subscriptionId: subscriptionId,
                        billingCycle: billingCycle,
                        amount: numericPlanPrice
                    });
                } catch (error) {
                    functions.logger.error('CRITICAL FAILURE: Payment succeeded but Firebase user creation failed.', error);
                    res.status(500).send({ error: 'Payment succeeded, but user account creation failed. Please contact support.' });
                }
            } else {
                const message = response.getMessages().getMessage()[0];
                const errorCode = message.getCode();
                const errorMessage = message.getText();
                functions.logger.error(`Authorize.Net transaction FAILED. Code: ${errorCode}, Message: ${errorMessage}`);
                res.status(400).send({ error: `Payment failed: ${errorMessage}` });
            }
        });
    } catch (error) {
        functions.logger.error("Unhandled error in createSubscription:", error);
        res.status(500).send({ error: 'Internal server error. Please try again later.' });
    }
});