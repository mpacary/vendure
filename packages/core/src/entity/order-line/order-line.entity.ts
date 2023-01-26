import { Adjustment, AdjustmentType, Discount, TaxLine } from '@vendure/common/lib/generated-types';
import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { summate } from '@vendure/common/lib/shared-utils';
import { Column, Entity, Index, ManyToOne, OneToOne } from 'typeorm';

import { Calculated } from '../../common/calculated-decorator';
import { grossPriceOf, netPriceOf } from '../../common/tax-utils';
import { HasCustomFields } from '../../config/custom-field/custom-field-types';
import { Asset } from '../asset/asset.entity';
import { VendureEntity } from '../base/base.entity';
import { Channel } from '../channel/channel.entity';
import { CustomOrderLineFields } from '../custom-entity-fields';
import { EntityId } from '../entity-id.decorator';
import { Order } from '../order/order.entity';
import { ProductVariant } from '../product-variant/product-variant.entity';
import { ShippingLine } from '../shipping-line/shipping-line.entity';
import { Cancellation } from '../stock-movement/cancellation.entity';
import { TaxCategory } from '../tax-category/tax-category.entity';

/**
 * @description
 * A single line on an {@link Order} which contains one or more {@link OrderItem}s.
 *
 * @docsCategory entities
 */
@Entity()
export class OrderLine extends VendureEntity implements HasCustomFields {
    constructor(input?: DeepPartial<OrderLine>) {
        super(input);
    }

    @ManyToOne(type => Channel, { nullable: true, onDelete: 'SET NULL' })
    sellerChannel?: Channel;

    @EntityId({ nullable: true })
    sellerChannelId?: ID;

    @Index()
    @ManyToOne(type => ShippingLine, { nullable: true, onDelete: 'SET NULL' })
    shippingLine?: ShippingLine;

    @EntityId({ nullable: true })
    shippingLineId?: ID;

    @Index()
    @ManyToOne(type => ProductVariant)
    productVariant: ProductVariant;

    @EntityId()
    productVariantId: ID;

    @Index()
    @ManyToOne(type => TaxCategory)
    taxCategory: TaxCategory;

    @Index()
    @ManyToOne(type => Asset)
    featuredAsset: Asset;

    // @OneToMany(type => OrderItem, item => item.line, { eager: true })
    // items: OrderItem[];

    @Index()
    @ManyToOne(type => Order, order => order.lines, { onDelete: 'CASCADE' })
    order: Order;

    @Column()
    quantity: number;

    /**
     * @description
     * The quantity of this OrderLine at the time the order was placed (as per the {@link OrderPlacedStrategy}).
     */
    @Column({ default: 0 })
    orderPlacedQuantity: number;

    /**
     * @description
     * The price as calculated when the OrderItem was first added to the Order. Usually will be identical to the
     * `listPrice`, except when the ProductVariant price has changed in the mean time and a re-calculation of
     * the Order has been performed.
     */
    @Column({ nullable: true })
    initialListPrice: number;

    /**
     * @description
     * This is the price as listed by the ProductVariant (and possibly modified by the {@link OrderItemPriceCalculationStrategy}),
     * which, depending on the current Channel, may or may not include tax.
     */
    @Column()
    listPrice: number;

    /**
     * @description
     * Whether or not the listPrice includes tax, which depends on the settings
     * of the current Channel.
     */
    @Column()
    listPriceIncludesTax: boolean;

    @Column('simple-json')
    adjustments: Adjustment[];

    @Column('simple-json')
    taxLines: TaxLine[];

    @OneToOne(type => Cancellation, cancellation => cancellation.orderLine)
    cancellation: Cancellation;

    @Column(type => CustomOrderLineFields)
    customFields: CustomOrderLineFields;

    /**
     * @description
     * The price of a single unit, excluding tax and discounts.
     */
    @Calculated()
    get unitPrice(): number {
        return this.listPriceIncludesTax ? netPriceOf(this.listPrice, this.taxRate) : this.listPrice;
    }

    /**
     * @description
     * The price of a single unit, including tax but excluding discounts.
     */
    @Calculated()
    get unitPriceWithTax(): number {
        return this.listPriceIncludesTax ? this.listPrice : grossPriceOf(this.listPrice, this.taxRate);
    }

    /**
     * @description
     * Non-zero if the `unitPrice` has changed since it was initially added to Order.
     */
    @Calculated()
    get unitPriceChangeSinceAdded(): number {
        const { initialListPrice, listPriceIncludesTax } = this;
        const initialPrice = listPriceIncludesTax
            ? netPriceOf(initialListPrice, this.taxRate)
            : initialListPrice;
        return this.unitPrice - initialPrice;
    }

    /**
     * @description
     * Non-zero if the `unitPriceWithTax` has changed since it was initially added to Order.
     */
    @Calculated()
    get unitPriceWithTaxChangeSinceAdded(): number {
        const { initialListPrice, listPriceIncludesTax } = this;
        const initialPriceWithTax = listPriceIncludesTax
            ? initialListPrice
            : grossPriceOf(initialListPrice, this.taxRate);
        return this.unitPriceWithTax - initialPriceWithTax;
    }

    /**
     * @description
     * The price of a single unit including discounts, excluding tax.
     *
     * If Order-level discounts have been applied, this will not be the
     * actual taxable unit price (see `proratedUnitPrice`), but is generally the
     * correct price to display to customers to avoid confusion
     * about the internal handling of distributed Order-level discounts.
     */
    @Calculated()
    get discountedUnitPrice(): number {
        const result = this.listPrice + this.getAdjustmentsTotal(AdjustmentType.PROMOTION);
        return this.listPriceIncludesTax ? netPriceOf(result, this.taxRate) : result;
    }

    /**
     * @description
     * The price of a single unit including discounts and tax
     */
    @Calculated()
    get discountedUnitPriceWithTax(): number {
        const result = this.listPrice + this.getAdjustmentsTotal(AdjustmentType.PROMOTION);
        return this.listPriceIncludesTax ? result : grossPriceOf(result, this.taxRate);
    }

    /**
     * @description
     * The actual unit price, taking into account both item discounts _and_ prorated (proportionally-distributed)
     * Order-level discounts. This value is the true economic value of the OrderItem, and is used in tax
     * and refund calculations.
     */
    @Calculated()
    get proratedUnitPrice(): number {
        const result = this.listPrice + this.getAdjustmentsTotal();
        return this.listPriceIncludesTax ? netPriceOf(result, this.taxRate) : result;
    }

    /**
     * @description
     * The `proratedUnitPrice` including tax.
     */
    @Calculated()
    get proratedUnitPriceWithTax(): number {
        const result = this.listPrice + this.getAdjustmentsTotal();
        return this.listPriceIncludesTax ? result : grossPriceOf(result, this.taxRate);
    }

    @Calculated()
    get unitTax(): number {
        return this.unitPriceWithTax - this.unitPrice;
    }

    @Calculated()
    get proratedUnitTax(): number {
        return this.proratedUnitPriceWithTax - this.proratedUnitPrice;
    }

    /**
     * @description
     * The total of all price adjustments. Will typically be a negative number due to discounts.
     */
    private getAdjustmentsTotal(type?: AdjustmentType): number {
        if (!this.adjustments || this.quantity === 0) {
            return 0;
        }
        return Math.round(
            this.adjustments
                .filter(adjustment => (type ? adjustment.type === type : true))
                .map(adjustment => adjustment.amount / Math.max(this.orderPlacedQuantity, this.quantity))
                .reduce((total, a) => total + a, 0),
        );
    }

    /*@Calculated()
    get quantity(): number {
        return this.activeItems.length;
    }*/

    // @Calculated({relations: ['items']})
    // get adjustments(): Adjustment[] {
    //     return this.activeItems.reduce(
    //         (adjustments, item) => [...adjustments, ...(item.adjustments || [])],
    //         [] as Adjustment[],
    //     );
    // }

    // @Calculated({relations: ['items']})
    // get taxLines(): TaxLine[] {
    //     return this.firstActiveItemPropOr('taxLines', []);
    // }

    @Calculated()
    get taxRate(): number {
        return summate(this.taxLines, 'taxRate');
    }

    /**
     * @description
     * The total price of the line excluding tax and discounts.
     */
    @Calculated()
    get linePrice(): number {
        return this.unitPrice * this.quantity;
    }

    /**
     * @description
     * The total price of the line including tax but excluding discounts.
     */
    @Calculated()
    get linePriceWithTax(): number {
        return this.unitPriceWithTax * this.quantity;
    }

    /**
     * @description
     * The price of the line including discounts, excluding tax.
     */
    @Calculated()
    get discountedLinePrice(): number {
        return this.discountedUnitPrice * this.quantity;
    }

    /**
     * @description
     * The price of the line including discounts and tax.
     */
    @Calculated()
    get discountedLinePriceWithTax(): number {
        return this.discountedUnitPriceWithTax * this.quantity;
    }

    @Calculated()
    get discounts(): Discount[] {
        const priceIncludesTax = this.listPriceIncludesTax;
        // Group discounts together, so that it does not list a new
        // discount row for each OrderItem in the line
        const groupedDiscounts = new Map<string, Discount>();
        for (const adjustment of this.adjustments) {
            const discountGroup = groupedDiscounts.get(adjustment.adjustmentSource);
            const unitAdjustmentAmount =
                (adjustment.amount / Math.max(this.orderPlacedQuantity, this.quantity)) * this.quantity;
            const amount = priceIncludesTax
                ? netPriceOf(unitAdjustmentAmount, this.taxRate)
                : unitAdjustmentAmount;
            const amountWithTax = priceIncludesTax
                ? unitAdjustmentAmount
                : grossPriceOf(unitAdjustmentAmount, this.taxRate);
            if (discountGroup) {
                discountGroup.amount += amount;
                discountGroup.amountWithTax += amountWithTax;
            } else {
                groupedDiscounts.set(adjustment.adjustmentSource, {
                    ...(adjustment as Omit<Adjustment, '__typename'>),
                    amount,
                    amountWithTax,
                });
            }
        }
        return [...groupedDiscounts.values()];
    }

    /**
     * @description
     * The total tax on this line.
     */
    @Calculated()
    get lineTax(): number {
        return this.unitTax * this.quantity;
    }

    /**
     * @description
     * The actual line price, taking into account both item discounts _and_ prorated (proportionally-distributed)
     * Order-level discounts. This value is the true economic value of the OrderLine, and is used in tax
     * and refund calculations.
     */
    @Calculated()
    get proratedLinePrice(): number {
        return this.proratedUnitPrice * this.quantity;
    }

    /**
     * @description
     * The `proratedLinePrice` including tax.
     */
    @Calculated()
    get proratedLinePriceWithTax(): number {
        return this.proratedUnitPriceWithTax * this.quantity;
    }

    @Calculated()
    get proratedLineTax(): number {
        return this.proratedUnitTax * this.quantity;
    }

    /**
     * Returns all non-cancelled OrderItems on this line.
     */
    // get activeItems(): OrderItem[] {
    //     if (this.items == null) {
    //         Logger.warn(
    //             `Attempted to access OrderLine.items without first joining the relation: `,
    //         );
    //     }
    //     return (this.items || []).filter(i => !i.cancelled);
    // }

    addAdjustment(adjustment: Adjustment) {
        this.adjustments = this.adjustments.concat(adjustment);
    }

    /**
     * Clears Adjustments from all OrderItems of the given type. If no type
     * is specified, then all adjustments are removed.
     */
    clearAdjustments(type?: AdjustmentType) {
        if (!type) {
            this.adjustments = [];
        } else {
            this.adjustments = this.adjustments ? this.adjustments.filter(a => a.type !== type) : [];
        }
    }
}
